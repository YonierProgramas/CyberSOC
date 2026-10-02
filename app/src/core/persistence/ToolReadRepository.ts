import type { Database } from './Database';
import type { Zone } from '../../shared/protocol';
import { zoneSchema } from '../../shared/protocol';
import { scanProfileSchema } from '../../shared/scan-profile';
import { ScanProfiles } from '../zones/ScanProfiles';
import { z } from 'zod';

export interface RiskResult {
  id: string;
  jobId: string;
  seq: number;
  fileName: string;
  path: string;
  sha256: string | null;
  verdict: string;
  engineScore: number | null;
  zone: Zone | null;
}
export interface ToolEvidence {
  id: string;
  source: string;
  code: string;
  title: string;
  severity: string;
  points: number;
  decisive: boolean;
  confidence: number | null;
}
export interface LayerScope {
  resultId?: string | null;
  jobId?: string | null;
  zone?: Zone | null;
}
const resultColumns = `id, job_id AS jobId, seq, file_name AS fileName, path, sha256,
  verdict, engine_score AS engineScore, zone`;

/** Frontera de lectura para las herramientas: solo SELECT, sin métodos de escritura. */
export class ToolReadRepository {
  constructor(private readonly db: Database) {}

  job(id?: string | null) {
    const row =
      id == null
        ? this.jobs(1)[0]
        : this.db
            .prepare(
              `SELECT ${jobColumns}
      FROM scan_jobs WHERE id = ?`,
            )
            .get(id);
    if (!row) throw new Error('NOT_FOUND');
    return row;
  }
  jobs(limit: number) {
    return this.db
      .prepare(
        `SELECT ${jobColumns} FROM scan_jobs
      ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit);
  }
  result(id: string): RiskResult & {
    sizeBytes: number | null;
    detectedType: string | null;
    riskLevel: string | null;
    status: string;
  } {
    const row = this.db
      .prepare(
        `SELECT ${resultColumns}, size_bytes AS sizeBytes,
      detected_type AS detectedType, risk_level AS riskLevel, status FROM scan_results WHERE id = ?`,
      )
      .get(id);
    if (!row) throw new Error('NOT_FOUND');
    return row as unknown as ReturnType<ToolReadRepository['result']>;
  }
  results(
    jobId: string,
    limit: number,
    verdict?: string | null,
    minScore?: number | null,
  ) {
    this.job(jobId);
    return this.db
      .prepare(
        `SELECT ${resultColumns} FROM scan_results
      WHERE job_id = ? AND (? IS NULL OR verdict = ?) AND (? IS NULL OR engine_score >= ?)
      ORDER BY seq, id LIMIT ?`,
      )
      .all(
        jobId,
        verdict ?? null,
        verdict ?? null,
        minScore ?? null,
        minScore ?? null,
        limit,
      ) as unknown as RiskResult[];
  }
  *riskCandidates(jobId: string): Iterable<RiskResult> {
    this.job(jobId);
    // Iterador: TopK recibe cada fila una vez, sin cargar todos los resultados.
    for (const row of this.db
      .prepare(
        `SELECT ${resultColumns} FROM scan_results
      WHERE job_id = ? AND engine_score IS NOT NULL ORDER BY seq, id`,
      )
      .iterate(jobId))
      yield row as unknown as RiskResult;
  }
  counts(jobId: string) {
    return {
      total: Number(
        this.db
          .prepare('SELECT COUNT(*) AS n FROM scan_results WHERE job_id = ?')
          .get(jobId)!.n,
      ),
      verdicts: this.db
        .prepare(
          `SELECT verdict, COUNT(*) AS files FROM scan_results
        WHERE job_id = ? GROUP BY verdict ORDER BY verdict`,
        )
        .all(jobId),
      statuses: this.db
        .prepare(
          `SELECT status, COUNT(*) AS files FROM scan_results
        WHERE job_id = ? GROUP BY status ORDER BY status`,
        )
        .all(jobId),
    };
  }
  analysis(kind: 'FILE_RESULT' | 'JOB_SUMMARY', id: string) {
    const column = kind === 'FILE_RESULT' ? 'result_id' : 'job_id';
    const row = this.db
      .prepare(
        `SELECT id, model, response_json AS responseJson, created_at AS createdAt
      FROM ai_analyses WHERE kind = ? AND ${column} = ? AND validation_status = 'VALID'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(kind, id);
    return row
      ? {
          id: row.id,
          model: row.model,
          createdAt: row.createdAt,
          response: JSON.parse(String(row.responseJson)) as unknown,
        }
      : null;
  }
  evidence(resultId: string): ToolEvidence[] {
    this.result(resultId);
    return this.db
      .prepare(
        `SELECT evidence_key AS id, source, code, title, severity, points,
      decisive, confidence FROM evidences WHERE result_id = ?
      ORDER BY length(evidence_key), evidence_key`,
      )
      .all(resultId)
      .map((row) => ({
        ...row,
        decisive: row.decisive === 1,
      })) as unknown as ToolEvidence[];
  }
  layers(resultId: string) {
    this.result(resultId);
    return this.db
      .prepare(
        `SELECT layer, status, reason, hits, points, duration_ms AS ms
      FROM result_layers WHERE result_id = ? ORDER BY layer`,
      )
      .all(resultId);
  }
  quarantine(status?: string | null) {
    // Lista explícita: nunca entregar claves, IV, tags, blobs ni errores internos a la IA.
    return this.db
      .prepare(
        `SELECT id, result_id AS resultId, original_path AS originalPath,
      sha256, size_bytes AS sizeBytes, reason, verdict_snapshot AS verdict, status,
      quarantined_at AS quarantinedAt FROM quarantine_items
      WHERE (? IS NULL OR status = ?) ORDER BY quarantined_at DESC, id LIMIT 21`,
      )
      .all(status ?? null, status ?? null);
  }
  hash(sha256: string) {
    return {
      ...this.db
        .prepare(
          `SELECT COUNT(*) AS timesSeen, MIN(scanned_at) AS firstSeen,
        MAX(scanned_at) AS lastSeen FROM scan_results WHERE sha256 = ?`,
        )
        .get(sha256),
      allowlisted: !!this.db
        .prepare('SELECT 1 FROM allowlist WHERE sha256 = ?')
        .get(sha256),
    };
  }
  profiles() {
    const saved = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('scan.zoneProfiles.v1');
    // Sin BD en el constructor: obtener defaults nunca inicializa settings.
    return saved
      ? z
          .record(zoneSchema, scanProfileSchema)
          .parse(JSON.parse(String(saved.value_json)))
      : new ScanProfiles().snapshot();
  }
  layerReport(scope: LayerScope) {
    if (scope.resultId) this.result(scope.resultId);
    if (scope.jobId) this.job(scope.jobId);
    const rows = this.db
      .prepare(
        `WITH reasons AS (
      SELECT l.layer, l.status, l.reason, COUNT(*) AS files,
        SUM(l.hits) AS hits, SUM(l.points) AS points, COALESCE(SUM(l.duration_ms), 0) AS ms
      FROM result_layers l JOIN scan_results r ON r.id = l.result_id
      WHERE (? IS NULL OR r.id = ?) AND (? IS NULL OR r.job_id = ?) AND (? IS NULL OR r.zone = ?)
      GROUP BY l.layer, l.status, l.reason
    ) SELECT layer, status, SUM(files) AS files, SUM(hits) AS hits,
      SUM(points) AS points, SUM(ms) AS ms,
      json_group_array(json_object('reason', reason, 'files', files)) AS reasonsJson
      FROM reasons GROUP BY layer, status ORDER BY layer, status`,
      )
      .all(
        scope.resultId ?? null,
        scope.resultId ?? null,
        scope.jobId ?? null,
        scope.jobId ?? null,
        scope.zone ?? null,
        scope.zone ?? null,
      );
    return rows.map(({ reasonsJson, ...row }) => ({
      ...row,
      reasons: (
        JSON.parse(String(reasonsJson)) as {
          reason: string | null;
          files: number;
        }[]
      ).filter((reason) => reason.reason !== null),
    }));
  }
}
const jobColumns = `id, target_path AS targetPath, status, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt, files_discovered AS filesDiscovered,
  files_processed AS filesProcessed, files_error AS filesError, files_skipped AS filesSkipped,
  bytes_processed AS bytesProcessed`;

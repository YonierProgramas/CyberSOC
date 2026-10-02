import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../persistence/Database';
import { zoneSchema } from '../../shared/protocol';

const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const reportFiltersSchema = z
  .strictObject({
    jobId: z.string().min(1).max(128).nullish(),
    zone: zoneSchema.nullish(),
    verdicts: z
      .array(
        z.enum([
          'CLEAN',
          'SUSPICIOUS',
          'DETECTED',
          'NOT_ANALYZED',
          'NOT_EVALUATED',
        ]),
      )
      .min(1)
      .max(5)
      .nullish(),
    from: date.nullish(),
    to: date.nullish(),
  })
  .refine(
    (filters) =>
      !filters.from ||
      !filters.to ||
      boundary(filters.from, false) <= boundary(filters.to, true),
    'El intervalo de fechas está invertido.',
  );
export type ReportFilters = z.infer<typeof reportFiltersSchema>;
export type ReportRow = Record<string, string | number | null>;
const narrativeSchema = z.strictObject({
  executiveSummary: z.string().max(8000),
  conclusions: z.array(z.string().max(2000)).max(20),
  citedResultIds: z.array(z.string().min(1)).max(100),
});
export interface ReportDraft {
  schema: 'cybersoc.report/v1';
  reportDraftId: string;
  createdAt: string;
  filters: ReportFilters;
  total: number;
  verdicts: ReportRow[];
  zones: ReportRow[];
  jobs: ReportRow[];
  results: ReportRow[];
  evidence: ReportRow[];
  layers: ReportRow[];
  assessments: ReportRow[];
  aiSummaries: ReportRow[];
  aiNarrative:
    (z.infer<typeof narrativeSchema> & { label: 'Generado por IA' }) | null;
}

function boundary(value: string, end: boolean): string {
  return new Date(
    value.length === 10
      ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`
      : value,
  ).toISOString();
}

export class ReportBuilder {
  // Invariante del Map: UUID único -> snapshot privado, con caducidad y capacidad.
  // Buscar/insertar/eliminar: O(1) promedio. La copia defensiva cuesta O(tamaño del
  // reporte); purgar entradas al construir cuesta O(c), c <= maxDrafts.
  private readonly cache = new Map<
    string,
    { draft: ReportDraft; expires: number }
  >();
  constructor(
    private readonly db: Database,
    private readonly options: {
      now?: () => number;
      maxDrafts?: number;
      ttlMs?: number;
    } = {},
  ) {
    if (
      !Number.isSafeInteger(options.maxDrafts ?? 10) ||
      (options.maxDrafts ?? 10) < 1 ||
      !Number.isSafeInteger(options.ttlMs ?? 900000) ||
      (options.ttlMs ?? 900000) < 1
    )
      throw new RangeError('Límites de caché inválidos.');
  }
  get(id: string): ReportDraft {
    const entry = this.cache.get(id);
    if (!entry || entry.expires <= this.now()) {
      this.cache.delete(id);
      throw new Error('NOT_FOUND');
    }
    return structuredClone(entry.draft);
  }
  /** Solo se admite redacción de IA; nunca cifras, resultados ni veredictos. */
  attachNarrative(id: string, input: unknown): void {
    const narrative = narrativeSchema.parse(input);
    const draft = this.get(id);
    if (
      narrative.citedResultIds.some(
        (ref) => !draft.results.some((row) => row.id === ref),
      )
    )
      throw new Error('La redacción cita un resultado ajeno al reporte.');
    this.cache.get(id)!.draft.aiNarrative = {
      ...narrative,
      label: 'Generado por IA',
    };
  }
  build(input: ReportFilters = {}): ReportDraft {
    const filters = reportFiltersSchema.parse(input);
    if (filters.from) filters.from = boundary(filters.from, false);
    if (filters.to) filters.to = boundary(filters.to, true);
    const clauses = ['1=1'];
    const params: (string | number)[] = [];
    if (filters.jobId) {
      clauses.push('r.job_id = ?');
      params.push(filters.jobId);
    }
    if (filters.zone) {
      clauses.push('r.zone = ?');
      params.push(filters.zone);
    }
    if (filters.verdicts) {
      clauses.push(
        `r.verdict IN (${filters.verdicts.map(() => '?').join(',')})`,
      );
      params.push(...filters.verdicts);
    }
    if (filters.from) {
      clauses.push('julianday(r.scanned_at) >= julianday(?)');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('julianday(r.scanned_at) <= julianday(?)');
      params.push(filters.to);
    }
    const cte = `WITH selected AS (SELECT r.* FROM scan_results r WHERE ${clauses.join(' AND ')})`;
    const rows = (sql: string) =>
      this.db.prepare(`${cte} ${sql}`).all(...params) as ReportRow[];
    // SAVEPOINT inicia una instantánea de lectura diferida y permite uso anidado.
    // Solo ejecutamos SELECT; no se escriben registros ni se mantiene abierta al exportar.
    const savepoint = `report_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    let draft: ReportDraft;
    try {
      if (
        filters.jobId &&
        !this.db
          .prepare('SELECT id FROM scan_jobs WHERE id=?')
          .get(filters.jobId)
      )
        throw new Error('NOT_FOUND');
      const jobsSql = `SELECT id, target_path AS path, target_kind AS kind, status,
        created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
        engine_version AS engineVersion, signatures_version AS signaturesVersion,
        ruleset_version AS rulesetVersion, protocol_version AS protocolVersion, profile_json AS profileJson
        FROM scan_jobs`;
      draft = {
        schema: 'cybersoc.report/v1',
        reportDraftId: randomUUID(),
        createdAt: new Date(this.now()).toISOString(),
        filters,
        total: Number(rows('SELECT COUNT(*) AS n FROM selected')[0]!.n),
        verdicts: rows(
          'SELECT verdict, COUNT(*) AS files FROM selected GROUP BY verdict ORDER BY verdict',
        ),
        zones: rows(
          'SELECT zone, COUNT(*) AS files FROM selected GROUP BY zone ORDER BY zone',
        ),
        jobs: filters.jobId
          ? (this.db
              .prepare(`${jobsSql} WHERE id=?`)
              .all(filters.jobId) as ReportRow[])
          : rows(
              `${jobsSql} WHERE id IN (SELECT job_id FROM selected) ORDER BY created_at,id`,
            ),
        results:
          rows(`SELECT id,job_id AS jobId,seq,file_name AS fileName,path,sha256,status,verdict,
          engine_score AS score,risk_level AS riskLevel,zone,size_bytes AS sizeBytes,detected_type AS detectedType,scanned_at AS scannedAt
          FROM selected ORDER BY job_id,seq,id`),
        evidence:
          rows(`SELECT e.result_id AS resultId,e.evidence_key AS evidenceId,e.source,e.code,e.title,e.severity,e.points,e.decisive,e.confidence
          FROM evidences e JOIN selected s ON s.id=e.result_id ORDER BY e.result_id,length(e.evidence_key),e.evidence_key`),
        layers:
          rows(`SELECT l.result_id AS resultId,l.layer,l.status,l.reason,l.hits,l.points,l.duration_ms AS ms
          FROM result_layers l JOIN selected s ON s.id=l.result_id ORDER BY l.result_id,l.layer`),
        assessments:
          rows(`SELECT a.result_id AS resultId,a.engine_verdict AS engineVerdict,a.final_verdict AS finalVerdict,
          a.final_level AS finalLevel,a.origin,a.policy_version AS policyVersion,a.decided_at AS decidedAt
          FROM risk_assessments a JOIN selected s ON s.id=a.result_id ORDER BY a.result_id`),
        aiSummaries:
          rows(`SELECT a.id,a.kind,a.result_id AS resultId,a.job_id AS jobId,a.model,a.created_at AS createdAt,
          json_extract(a.response_json,'$.summary') AS summary,'Generado por IA' AS label
          FROM ai_analyses a WHERE a.validation_status='VALID'
          AND ((a.kind='FILE_RESULT' AND a.result_id IN (SELECT id FROM selected)) OR
            (a.kind='JOB_SUMMARY' AND a.job_id IN (SELECT job_id FROM selected)))
          AND NOT EXISTS (SELECT 1 FROM ai_analyses b WHERE b.kind=a.kind AND b.validation_status='VALID'
            AND ((a.kind='FILE_RESULT' AND b.result_id=a.result_id) OR
              (a.kind='JOB_SUMMARY' AND b.job_id=a.job_id))
            AND (b.created_at>a.created_at OR (b.created_at=a.created_at AND b.rowid>a.rowid)))
          ORDER BY a.created_at,a.id`),
        aiNarrative: null,
      };
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
    for (const [id, entry] of this.cache)
      if (entry.expires <= this.now()) this.cache.delete(id);
    if (this.cache.size >= (this.options.maxDrafts ?? 10))
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(draft.reportDraftId, {
      draft,
      expires: this.now() + (this.options.ttlMs ?? 900000),
    });
    return structuredClone(draft);
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

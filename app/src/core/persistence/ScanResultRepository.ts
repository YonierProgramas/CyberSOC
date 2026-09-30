import type { StatementSync } from 'node:sqlite';
import type { Evidence, LayerTrace } from '../../shared/protocol';
import type { FileErrorCode, FileScanStatus } from '../domain/types';
import type { Database } from './Database';
import { requireNonNegativeInteger } from './validation';
import {
  aiStatusSchema,
  riskLevelSchema,
  scoreSchema,
  type AIStatus,
  type RiskLevel,
} from './assessmentTypes';
import { EvidenceRepository } from './EvidenceRepository';
import { LayerTraceRepository } from './LayerTraceRepository';
import {
  RiskAssessmentRepository,
  type InsertRiskAssessment,
} from './RiskAssessmentRepository';

export interface ScanResultRecord {
  id: string;
  jobId: string;
  seq: number;
  path: string;
  fileName: string;
  extension: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  status: FileScanStatus;
  sha256: string | null;
  verdict:
    'NOT_EVALUATED' | 'CLEAN' | 'SUSPICIOUS' | 'DETECTED' | 'NOT_ANALYZED';
  errorCode: FileErrorCode | null;
  errorMessage: string | null;
  durationMs: number | null;
  scannedAt: string;
  detectedType: string | null;
  engineScore: number | null;
  riskLevel: RiskLevel | null;
  aiStatus: AIStatus;
}

export interface InsertScanResult {
  id: string;
  jobId: string;
  seq: number;
  path: string;
  fileName: string;
  status: FileScanStatus;
  extension?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  sha256?: string | null;
  errorCode?: FileErrorCode | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  scannedAt?: string;
  verdict?: ScanResultRecord['verdict'];
  detectedType?: string | null;
  engineScore?: number | null;
  riskLevel?: RiskLevel | null;
  aiStatus?: AIStatus;
}

export interface InsertCompleteResult {
  result: Omit<InsertScanResult, 'verdict' | 'engineScore' | 'riskLevel'>;
  evidence: readonly Evidence[];
  layers: readonly LayerTrace[];
  // 003 exige puntuación y nivel: no inventar evaluación para un archivo no analizado.
  assessment: Omit<InsertRiskAssessment, 'resultId'> | null;
}

const selectResult = `SELECT
  id, job_id AS jobId, seq, path, file_name AS fileName, extension,
  size_bytes AS sizeBytes, modified_at AS modifiedAt, status, sha256, verdict,
  error_code AS errorCode, error_message AS errorMessage,
  duration_ms AS durationMs, scanned_at AS scannedAt,
  detected_type AS detectedType, engine_score AS engineScore,
  risk_level AS riskLevel, ai_status AS aiStatus
FROM scan_results`;

export class ScanResultRepository {
  private readonly insert: StatementSync;
  private readonly find: StatementSync;
  private readonly byJob: StatementSync;

  constructor(private readonly database: Database) {
    // Los productores S1 conservan NOT_EVALUATED mientras no entreguen una decisión.
    this.insert = database.prepare(`INSERT INTO scan_results
      (id, job_id, seq, path, file_name, extension, size_bytes, modified_at, status,
       sha256, error_code, error_message, duration_ms, scanned_at,
       verdict, detected_type, engine_score, risk_level, ai_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.find = database.prepare(`${selectResult} WHERE id = ?`);
    this.byJob = database.prepare(
      `${selectResult} WHERE job_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
    );
  }

  insertResult(input: InsertScanResult): ScanResultRecord {
    requireNonNegativeInteger(input.seq, 'seq');
    if (input.engineScore != null) scoreSchema.parse(input.engineScore);
    if (input.riskLevel != null) riskLevelSchema.parse(input.riskLevel);
    const aiStatus = aiStatusSchema.parse(input.aiStatus ?? 'NOT_REQUIRED');
    return this.database.transaction(() => {
      this.insert.run(
        input.id,
        input.jobId,
        input.seq,
        input.path,
        input.fileName,
        input.extension ?? null,
        input.sizeBytes ?? null,
        input.modifiedAt ?? null,
        input.status,
        input.sha256 ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.durationMs ?? null,
        input.scannedAt ?? new Date().toISOString(),
        input.verdict ?? 'NOT_EVALUATED',
        input.detectedType ?? null,
        input.engineScore ?? null,
        input.riskLevel ?? null,
        aiStatus,
      );
      return this.find.get(input.id) as unknown as ScanResultRecord;
    });
  }

  insertComplete(input: InsertCompleteResult): ScanResultRecord {
    const { result, evidence, layers, assessment } = input;
    if (
      assessment === null &&
      (result.status === 'SCANNED' || evidence.some((item) => item.decisive))
    ) {
      throw new Error('Un análisis completado o decisivo requiere evaluación.');
    }
    // Una sola transacción exterior: cualquier fallo revierte las cuatro tablas.
    // Los SAVEPOINT de los repositorios internos nunca confirman por separado.
    return this.database.transaction(() => {
      const saved = this.insertResult({
        ...result,
        verdict: assessment?.finalVerdict ?? 'NOT_ANALYZED',
        engineScore: assessment?.engineScore ?? null,
        riskLevel: assessment?.finalLevel ?? null,
      });
      new EvidenceRepository(this.database).insertMany(saved.id, evidence);
      new LayerTraceRepository(this.database).insertTrace(saved.id, layers);
      if (assessment !== null) {
        new RiskAssessmentRepository(this.database).insert({
          ...assessment,
          resultId: saved.id,
        });
      }
      return saved;
    });
  }

  get(id: string): ScanResultRecord | undefined {
    return this.find.get(id) as unknown as ScanResultRecord | undefined;
  }

  updateAIStatus(id: string, status: AIStatus): void {
    const { changes } = this.database
      .prepare('UPDATE scan_results SET ai_status = ? WHERE id = ?')
      .run(aiStatusSchema.parse(status), id);
    if (changes === 0) throw new Error(`No existe el resultado ${id}.`);
  }

  listByAIStatus(
    statuses: readonly AIStatus[],
    offset = 0,
    limit = 100,
  ): ScanResultRecord[] {
    requireNonNegativeInteger(offset, 'offset');
    requireNonNegativeInteger(limit, 'limit');
    const parsed = statuses.map((status) => aiStatusSchema.parse(status));
    if (parsed.length === 0) return [];
    // Solo se interpolan marcadores; los estados siempre son parámetros SQL.
    const placeholders = parsed.map(() => '?').join(', ');
    return this.database
      .prepare(
        `${selectResult} WHERE ai_status IN (${placeholders})
      ORDER BY scanned_at, job_id, seq, id LIMIT ? OFFSET ?`,
      )
      .all(...parsed, limit, offset) as unknown as ScanResultRecord[];
  }

  listByJob(jobId: string, offset: number, limit: number): ScanResultRecord[] {
    requireNonNegativeInteger(offset, 'offset');
    requireNonNegativeInteger(limit, 'limit');
    return this.byJob.all(
      jobId,
      limit,
      offset,
    ) as unknown as ScanResultRecord[];
  }
}

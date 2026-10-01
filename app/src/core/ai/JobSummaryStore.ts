import type { Database } from '../persistence/Database';
import {
  AIAnalysisRepository,
  type InsertAIAnalysis,
} from '../persistence/AIAnalysisRepository';
import { ScanJobRepository } from '../persistence/ScanJobRepository';
import { aiStatusSchema, type AIStatus } from '../persistence/assessmentTypes';
import type { JobSummaryFacts } from './JobSummaryContext';
import {
  JOB_SUMMARY_CONTEXT_LIMITS as L,
  jobSummaryContextSchema,
  jobSummarySchema,
  type JobSummary,
} from './schemas';

// Estado de IA del resumen de cada escaneo, en `settings` como el contador ai.autoCount.<job>.
// AppConfigStore ignora estas claves: no son ajustes del usuario.
const STATUS_PREFIX = 'ai.jobSummary.';
const evidenceItem =
  jobSummaryContextSchema.shape.topResults.element.shape.evidence.element;

export interface StoredJobSummary {
  analysisId: string;
  createdAt: string;
  summary: JobSummary;
}

/** Adaptador de persistencia del resumen de escaneo. Solo lee hechos ya guardados. */
export class JobSummaryStore {
  constructor(private readonly db: Database) {}

  /** Hechos del escaneo para el contexto. Lanza si el escaneo no existe. */
  facts(jobId: string): JobSummaryFacts {
    const job = new ScanJobRepository(this.db).get(jobId);
    if (!job) throw new Error('No existe el escaneo solicitado.');

    const verdicts: JobSummaryFacts['verdicts'] = {};
    for (const row of this.db
      .prepare(
        'SELECT verdict, COUNT(*) AS n FROM scan_results WHERE job_id = ? GROUP BY verdict',
      )
      .all(jobId)) {
      verdicts[row.verdict as keyof JobSummaryFacts['verdicts']] = Number(
        row.n,
      );
    }
    const countAssessments = (condition: string) =>
      Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM risk_assessments a
             JOIN scan_results r ON r.id = a.result_id
             WHERE r.job_id = ? AND ${condition}`,
          )
          .get(jobId)!.n,
      );

    // Mayor riesgo primero: DETECTED, SUSPICIOUS y luego por puntuación; seq desempata.
    // Se pide uno más que el tope para saber si la lista se recortó.
    const top = this.db
      .prepare(
        `SELECT r.id, r.file_name AS fileName, r.extension, r.verdict,
           r.engine_score AS score, r.risk_level AS riskLevel,
           COALESCE(a.origin = 'AI_ESCALATION', 0) AS escalated
         FROM scan_results r LEFT JOIN risk_assessments a ON a.result_id = r.id
         WHERE r.job_id = ? AND (r.verdict IN ('SUSPICIOUS', 'DETECTED') OR r.engine_score > 0)
         ORDER BY CASE r.verdict WHEN 'DETECTED' THEN 2 WHEN 'SUSPICIOUS' THEN 1 ELSE 0 END DESC,
           COALESCE(r.engine_score, -1) DESC, r.seq
         LIMIT ?`,
      )
      .all(jobId, L.maxTopResults + 1);
    const evidence = this.db.prepare(
      `SELECT source, code, severity FROM evidences WHERE result_id = ?
       ORDER BY length(evidence_key), evidence_key LIMIT ?`,
    );

    return {
      job,
      verdicts,
      aiEscalations: countAssessments("a.origin = 'AI_ESCALATION'"),
      reviewsRequired: countAssessments('a.review_required = 1'),
      topResults: top.map((row) => ({
        id: String(row.id),
        fileName: String(row.fileName),
        extension: row.extension === null ? null : String(row.extension),
        verdict:
          row.verdict as JobSummaryFacts['topResults'][number]['verdict'],
        score: row.score === null ? null : Number(row.score),
        riskLevel:
          row.riskLevel as JobSummaryFacts['topResults'][number]['riskLevel'],
        escalatedByAI: Number(row.escalated) === 1,
        evidence: evidence
          .all(String(row.id), L.maxEvidencePerResult + 1)
          .map((e) => evidenceItem.parse({ ...e })),
      })),
    };
  }

  status(jobId: string): AIStatus | null {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(STATUS_PREFIX + jobId);
    if (!row) return null;
    return aiStatusSchema.parse(JSON.parse(String(row.value_json)));
  }

  setStatus(jobId: string, status: AIStatus): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(
        STATUS_PREFIX + jobId,
        JSON.stringify(aiStatusSchema.parse(status)),
        new Date().toISOString(),
      );
  }

  /**
   * Marca el resumen como pendiente si el escaneo terminó (COMPLETED) y aún no tiene un
   * resumen final (COMPLETED o INVALID) ni uno en curso. Devuelve si hay que encolarlo.
   */
  markPending(jobId: string): boolean {
    return this.db.transaction(() => {
      const job = new ScanJobRepository(this.db).get(jobId);
      if (job?.status !== 'COMPLETED') return false;
      const current = this.status(jobId);
      if (
        current === 'COMPLETED' ||
        current === 'INVALID' ||
        current === 'RUNNING'
      )
        return false;
      this.setStatus(jobId, 'PENDING');
      return true;
    });
  }

  /** Resúmenes pendientes, en orden de creación del escaneo. Un RUNNING huérfano vuelve a PENDING. */
  pending(): string[] {
    this.db
      .prepare(
        `UPDATE settings SET value_json = '"PENDING"'
         WHERE substr(key, 1, ?) = ? AND value_json = '"RUNNING"'`,
      )
      .run(STATUS_PREFIX.length, STATUS_PREFIX);
    return this.jobsWithStatus(['PENDING', 'RETRY_WAIT']);
  }

  /** Resúmenes detenidos por credencial o red, para reanudarlos con `resume()`. */
  paused(): string[] {
    return this.jobsWithStatus(['NOT_CONFIGURED', 'UNAVAILABLE']);
  }

  /** Guarda el intento y el estado del resumen en una sola transacción. */
  saveAttempt(input: InsertAIAnalysis, status: AIStatus): void {
    this.db.transaction(() => {
      new AIAnalysisRepository(this.db).insert(input);
      this.setStatus(input.jobId!, status);
    });
  }

  /** Último resumen VALID del escaneo (para la UI), ya validado contra el esquema. */
  latestValid(jobId: string): StoredJobSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT id, created_at AS createdAt, response_json AS responseJson FROM ai_analyses
         WHERE job_id = ? AND kind = 'JOB_SUMMARY' AND validation_status = 'VALID'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(jobId);
    if (!row) return undefined;
    const parsed = jobSummarySchema.safeParse(
      JSON.parse(String(row.responseJson)),
    );
    return parsed.success
      ? {
          analysisId: String(row.id),
          createdAt: String(row.createdAt),
          summary: parsed.data,
        }
      : undefined;
  }

  private jobsWithStatus(statuses: readonly AIStatus[]): string[] {
    const values = statuses.map((status) => JSON.stringify(status));
    return this.db
      .prepare(
        `SELECT j.id FROM settings s JOIN scan_jobs j ON s.key = ? || j.id
         WHERE s.value_json IN (${values.map(() => '?').join(', ')})
         ORDER BY j.created_at, j.id`,
      )
      .all(STATUS_PREFIX, ...values)
      .map((row) => String(row.id));
  }
}

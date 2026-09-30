import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './Database';
import { type AIStatus, jsonTextSchema } from './assessmentTypes';
import {
  ScanResultRepository,
  type ScanResultRecord,
} from './ScanResultRepository';

const analysisSchema = z
  .strictObject({
    id: z.string().min(1),
    kind: z.enum(['FILE_RESULT', 'JOB_SUMMARY']),
    resultId: z.string().min(1).nullable().default(null),
    jobId: z.string().min(1).nullable().default(null),
    provider: z.string().min(1),
    model: z.string().nullable().default(null),
    promptVersion: z.string().min(1),
    contextJson: jsonTextSchema,
    // Se conserva la respuesta original, incluso cuando no es JSON válido.
    responseJson: z.string().nullable().default(null),
    validationStatus: z.enum([
      'VALID',
      'INVALID_JSON',
      'SCHEMA_ERROR',
      'UNKNOWN_EVIDENCE',
      'UNSAFE',
      'INCOMPLETE',
      'PROVIDER_ERROR',
    ]),
    errorKind: z.string().nullable().default(null),
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    latencyMs: z.number().int().nonnegative().nullable().default(null),
    createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  })
  .superRefine((item, ctx) => {
    if (
      (item.kind === 'FILE_RESULT' && item.resultId === null) ||
      (item.kind === 'JOB_SUMMARY' &&
        (item.jobId === null || item.resultId !== null))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Referencias incompatibles con kind',
      });
    }
    if (
      item.validationStatus === 'VALID' &&
      (item.responseJson === null ||
        !jsonTextSchema.safeParse(item.responseJson).success)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'VALID requiere respuesta JSON',
      });
    }
  });

export type InsertAIAnalysis = z.input<typeof analysisSchema>;
export type AIAnalysisRecord = z.output<typeof analysisSchema> & {
  contextSha256: string;
};

const selectAnalysis = `SELECT id, kind, result_id AS resultId, job_id AS jobId,
  provider, model, prompt_version AS promptVersion, context_json AS contextJson,
  context_sha256 AS contextSha256, response_json AS responseJson,
  validation_status AS validationStatus, error_kind AS errorKind,
  input_tokens AS inputTokens, output_tokens AS outputTokens, latency_ms AS latencyMs,
  created_at AS createdAt FROM ai_analyses`;

export class AIAnalysisRepository {
  constructor(private readonly database: Database) {}

  insert(input: InsertAIAnalysis): AIAnalysisRecord {
    const item = analysisSchema.parse(input);
    return this.database.transaction(() => {
      if (item.resultId !== null && item.jobId !== null) {
        const result = this.database
          .prepare('SELECT job_id FROM scan_results WHERE id = ?')
          .get(item.resultId);
        if (!result || result.job_id !== item.jobId)
          throw new Error('El resultado no pertenece al trabajo indicado.');
      }
      const contextSha256 = createHash('sha256')
        .update(item.contextJson, 'utf8')
        .digest('hex');
      // ISO UTC con precisión fija mantiene el orden cronológico al ordenar TEXT.
      const createdAt = new Date(item.createdAt).toISOString();
      this.database
        .prepare(
          `INSERT INTO ai_analyses
        (id, kind, result_id, job_id, provider, model, prompt_version, context_json,
         context_sha256, response_json, validation_status, error_kind, input_tokens,
         output_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          item.kind,
          item.resultId,
          item.jobId,
          item.provider,
          item.model,
          item.promptVersion,
          item.contextJson,
          contextSha256,
          item.responseJson,
          item.validationStatus,
          item.errorKind,
          item.inputTokens,
          item.outputTokens,
          item.latencyMs,
          createdAt,
        );
      return this.get(item.id)!;
    });
  }

  get(id: string): AIAnalysisRecord | undefined {
    return this.database
      .prepare(`${selectAnalysis} WHERE id = ?`)
      .get(id) as unknown as AIAnalysisRecord | undefined;
  }

  latestByResult(resultId: string): AIAnalysisRecord | undefined {
    return this.database
      .prepare(
        `${selectAnalysis}
      WHERE result_id = ? AND kind = 'FILE_RESULT'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(resultId) as unknown as AIAnalysisRecord | undefined;
  }

  latestValidByResult(resultId: string): AIAnalysisRecord | undefined {
    return this.database
      .prepare(
        `${selectAnalysis}
      WHERE result_id = ? AND kind = 'FILE_RESULT' AND validation_status = 'VALID'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(resultId) as unknown as AIAnalysisRecord | undefined;
  }

  // Los pendientes son resultados, incluso si todavía no existe un intento IA.
  // validation_status describe un intento terminado; ai_status describe el trabajo pendiente.
  listPendingByStatus(
    statuses: readonly AIStatus[] = ['PENDING', 'RETRY_WAIT'],
    offset = 0,
    limit = 100,
  ): ScanResultRecord[] {
    return new ScanResultRepository(this.database).listByAIStatus(
      statuses,
      offset,
      limit,
    );
  }
}

import { z } from 'zod';
import type { Database } from './Database';
import {
  jsonTextSchema,
  riskLevelSchema,
  scoreSchema,
} from './assessmentTypes';

const verdictSchema = z.enum(['CLEAN', 'SUSPICIOUS', 'DETECTED']);
const assessmentSchema = z.strictObject({
  resultId: z.string().min(1),
  engineVerdict: verdictSchema,
  engineScore: scoreSchema,
  aiOpinion: z
    .enum([
      'LIKELY_BENIGN',
      'SUSPICIOUS',
      'LIKELY_MALICIOUS',
      'INSUFFICIENT_EVIDENCE',
    ])
    .nullable()
    .default(null),
  aiConfidence: z.number().min(0).max(1).nullable().default(null),
  finalVerdict: verdictSchema,
  finalLevel: riskLevelSchema,
  reviewRequired: z.boolean(),
  origin: z.enum(['ENGINE', 'AI_ESCALATION', 'USER_ALLOWLIST']),
  traceJson: jsonTextSchema,
  policyVersion: z.string().min(1),
  decidedAt: z.iso.datetime().default(() => new Date().toISOString()),
});

export type InsertRiskAssessment = z.input<typeof assessmentSchema>;
export type RiskAssessmentRecord = z.output<typeof assessmentSchema>;

export class RiskAssessmentRepository {
  constructor(private readonly database: Database) {}

  // Guarda una decisión ya calculada por RiskPolicy; no infiere veredictos.
  insert(input: InsertRiskAssessment): RiskAssessmentRecord {
    const item = assessmentSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO risk_assessments
      (result_id, engine_verdict, engine_score, ai_opinion, ai_confidence,
       final_verdict, final_level, review_required, origin, trace_json, policy_version, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.resultId,
        item.engineVerdict,
        item.engineScore,
        item.aiOpinion,
        item.aiConfidence,
        item.finalVerdict,
        item.finalLevel,
        Number(item.reviewRequired),
        item.origin,
        item.traceJson,
        item.policyVersion,
        item.decidedAt,
      );
    return this.get(item.resultId)!;
  }

  get(resultId: string): RiskAssessmentRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT result_id AS resultId,
      engine_verdict AS engineVerdict, engine_score AS engineScore,
      ai_opinion AS aiOpinion, ai_confidence AS aiConfidence,
      final_verdict AS finalVerdict, final_level AS finalLevel,
      review_required AS reviewRequired, origin, trace_json AS traceJson,
      policy_version AS policyVersion, decided_at AS decidedAt
      FROM risk_assessments WHERE result_id = ?`,
      )
      .get(resultId);
    return row
      ? ({
          ...row,
          reviewRequired: row.reviewRequired === 1,
        } as unknown as RiskAssessmentRecord)
      : undefined;
  }
}

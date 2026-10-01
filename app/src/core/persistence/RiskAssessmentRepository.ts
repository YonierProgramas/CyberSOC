import { z } from 'zod';
import type { Database } from './Database';
import { decideRisk, type EngineVerdict } from '../risk/RiskPolicy';
import { AllowlistRepository } from './AllowlistRepository';
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

  /** Reevalúa los resultados conocidos del hash confirmado, conservando los hechos del motor. */
  applyAllowlist(sha256: string): void {
    if (!new AllowlistRepository(this.database).has(sha256)) return;
    this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT r.result_id, r.engine_verdict, r.engine_score
        FROM risk_assessments r JOIN scan_results s ON s.id=r.result_id WHERE s.sha256=?`,
        )
        .all(sha256);
      for (const row of rows) {
        const decision = decideRisk({
          verdict: row.engine_verdict as EngineVerdict,
          score: Number(row.engine_score),
          userAllowlisted: true,
        });
        this.database
          .prepare(
            `UPDATE risk_assessments SET final_verdict=?,final_level=?,
          review_required=0,origin=?,trace_json=?,policy_version=?,decided_at=? WHERE result_id=?`,
          )
          .run(
            decision.finalVerdict,
            decision.finalLevel,
            decision.origin,
            JSON.stringify(decision.trace),
            decision.policyVersion,
            new Date().toISOString(),
            String(row.result_id),
          );
        this.database
          .prepare('UPDATE scan_results SET verdict=?,risk_level=? WHERE id=?')
          .run(
            decision.finalVerdict,
            decision.finalLevel,
            String(row.result_id),
          );
      }
    });
  }

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

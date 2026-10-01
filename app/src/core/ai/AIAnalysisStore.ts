import type { Database } from '../persistence/Database';
import {
  AIAnalysisRepository,
  type InsertAIAnalysis,
} from '../persistence/AIAnalysisRepository';
import { ScanResultRepository } from '../persistence/ScanResultRepository';
import { EvidenceRepository } from '../persistence/EvidenceRepository';
import { LayerTraceRepository } from '../persistence/LayerTraceRepository';
import { RiskAssessmentRepository } from '../persistence/RiskAssessmentRepository';
import type { AIStatus } from '../persistence/assessmentTypes';
import { decideRisk, type PolicyAIAnalysis } from '../risk/RiskPolicy';
import type { AnalysisFacts } from './AIContextBuilder';
import type { Evidence } from '../../shared/protocol';

/** Adaptador de persistencia del flujo IA. No lee archivos ni ejecuta acciones sobre ellos. */
export class AIAnalysisStore {
  readonly results: ScanResultRepository;
  constructor(private readonly db: Database) {
    this.results = new ScanResultRepository(db);
  }

  load(id: string) {
    const result = this.results.get(id);
    if (!result) throw new Error('No existe el resultado solicitado.');
    const risk = new RiskAssessmentRepository(this.db).get(id);
    const evidence: Evidence[] = new EvidenceRepository(this.db)
      .listByResult(id)
      .map((e) => ({
        id: e.evidenceKey,
        source: e.source,
        code: e.code,
        title: e.title,
        severity: e.severity,
        points: e.points,
        decisive: e.decisive,
        confidence: e.confidence,
        facts: {},
      }));
    const versions = this.db
      .prepare('SELECT engine_version FROM scan_jobs WHERE id = ?')
      .get(result.jobId);
    const signature = new EvidenceRepository(this.db)
      .listByResult(id)
      .find((e) => e.source === 'SIGNATURES');
    const signatureVersion: unknown = signature
      ? (JSON.parse(signature.detailsJson) as Record<string, unknown>)
          .signaturesVersion
      : null;
    const history =
      result.sha256 === null
        ? 0
        : Number(
            this.db
              .prepare(
                `SELECT COUNT(*) AS count FROM scan_results
      WHERE sha256 = ? AND id <> ? AND (scanned_at < ? OR (scanned_at = ? AND rowid < (SELECT rowid FROM scan_results WHERE id = ?)))`,
              )
              .get(result.sha256, id, result.scannedAt, result.scannedAt, id)!
              .count,
          );
    const analysis: AnalysisFacts = {
      evidence,
      layers: new LayerTraceRepository(this.db)
        .listByResult(id)
        .map((l) => ({ ...l, reason: l.reason ?? undefined })),
      engineVersion:
        typeof versions?.engine_version === 'string'
          ? versions.engine_version
          : null,
      signaturesVersion:
        typeof signatureVersion === 'string' ? signatureVersion : null,
      score: risk?.engineScore ?? result.engineScore,
      riskLevel: result.riskLevel,
      detectedType: result.detectedType,
      timesSeenBefore: history,
    };
    return {
      result: { ...result, verdict: risk?.engineVerdict ?? result.verdict },
      analysis,
    };
  }

  setStatus(id: string, status: AIStatus): void {
    this.results.updateAIStatus(id, status);
  }

  pending(): string[] {
    // Un cierre abrupto puede dejar RUNNING; ningún proceso anterior sigue atendiendo al reiniciar.
    this.db.exec(
      "UPDATE scan_results SET ai_status = 'PENDING' WHERE ai_status = 'RUNNING'",
    );
    return this.db
      .prepare(
        "SELECT id FROM scan_results WHERE ai_status IN ('PENDING','RETRY_WAIT') ORDER BY scanned_at, job_id, seq, id",
      )
      .all()
      .map((r) => String(r.id));
  }

  reserveAutomatic(id: string, limit: number): boolean {
    return this.db.transaction(() => {
      const { result, analysis } = this.load(id);
      if (
        result.aiStatus !== 'NOT_REQUIRED' ||
        result.verdict === 'NOT_EVALUATED'
      )
        return false;
      if (
        result.verdict === 'CLEAN' &&
        !analysis.evidence.some((e) =>
          ['MEDIUM', 'HIGH', 'CRITICAL'].includes(e.severity),
        )
      )
        return false;
      const key = `ai.autoCount.${result.jobId}`;
      const row = this.db
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get(key);
      const count = row ? Number(JSON.parse(String(row.value_json))) : 0;
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error('Contador IA inválido.');
      if (count >= limit) return false;
      this.db
        .prepare(
          `INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
        )
        .run(key, String(count + 1), new Date().toISOString());
      this.setStatus(id, 'PENDING');
      return true;
    });
  }

  pausedResults(): string[] {
    return this.db
      .prepare(
        "SELECT id FROM scan_results WHERE ai_status IN ('NOT_CONFIGURED','UNAVAILABLE') ORDER BY scanned_at, job_id, seq, id",
      )
      .all()
      .map((row) => String(row.id));
  }

  saveAttempt(
    input: InsertAIAnalysis,
    status: AIStatus,
    ai: PolicyAIAnalysis,
  ): void {
    this.db.transaction(() => {
      new AIAnalysisRepository(this.db).insert(input);
      const { result, analysis } = this.load(input.resultId!);
      if (
        analysis.score !== null &&
        ['CLEAN', 'SUSPICIOUS', 'DETECTED'].includes(result.verdict)
      ) {
        const decision = decideRisk(
          {
            verdict: result.verdict as 'CLEAN' | 'SUSPICIOUS' | 'DETECTED',
            score: analysis.score,
            evidenceIds: analysis.evidence.map((item) => item.id),
          },
          ai,
        );
        // Actualización atómica junto al intento y al estado, sin borrar una evaluación previa.
        this.db
          .prepare(
            `INSERT INTO risk_assessments
          (result_id, engine_verdict, engine_score, ai_opinion, ai_confidence, final_verdict, final_level,
           review_required, origin, trace_json, policy_version, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(result_id) DO UPDATE SET ai_opinion=excluded.ai_opinion, ai_confidence=excluded.ai_confidence,
          final_verdict=excluded.final_verdict, final_level=excluded.final_level, review_required=excluded.review_required,
          origin=excluded.origin, trace_json=excluded.trace_json, policy_version=excluded.policy_version, decided_at=excluded.decided_at`,
          )
          .run(
            result.id,
            decision.engineVerdict,
            decision.engineScore,
            decision.aiOpinion,
            decision.aiConfidence,
            decision.finalVerdict,
            decision.finalLevel,
            Number(decision.reviewRequired),
            decision.origin,
            JSON.stringify(decision.trace),
            decision.policyVersion,
            new Date().toISOString(),
          );
        this.db
          .prepare(
            'UPDATE scan_results SET verdict = ?, risk_level = ? WHERE id = ?',
          )
          .run(decision.finalVerdict, decision.finalLevel, result.id);
      }
      this.setStatus(result.id, status);
    });
  }
}

// Type-only imports: this file also runs with Node type stripping
// (cobertura nativa en tests/risk-policy.cases.mjs).
import type { AIAssessment } from '../ai/schemas';
import type { RiskLevel } from '../persistence/assessmentTypes';

export const POLICY_VERSION = '3';
export const AI_PENDING_LABEL = 'IA pendiente / no disponible';

/** Thresholds of policy v2 (S3 plan, section «RiskPolicy v2»). */
export const ESCALATION_MIN_CONFIDENCE = 0.7;
export const FALSE_POSITIVE_REVIEW_MIN_CONFIDENCE = 0.8;
/** Maximum level a result escalated by the AI can reach. */
export const ESCALATION_LEVEL: RiskLevel = 'MEDIO';

/** Verdicts the policy evaluates. ERROR and NOT_ANALYZED do not get here (no score). */
export type EngineVerdict = 'CLEAN' | 'SUSPICIOUS' | 'DETECTED';
export type AIOpinion = AIAssessment['opinion'];
export type RiskOrigin = 'ENGINE' | 'AI_ESCALATION' | 'USER_ALLOWLIST';

/** Policy rule that decided the result (for the «¿Cómo se decidió?» panel). */
export type PolicyRule =
  | 'USER_ALLOWLIST'
  | 'DETECTED_KEPT'
  | 'SUSPICIOUS_KEPT'
  | 'SUSPICIOUS_POSSIBLE_FALSE_POSITIVE'
  | 'CLEAN_ESCALATED_BY_AI'
  | 'CLEAN_KEPT';

/** Same values as `ai_analyses.validation_status`. */
export type AIValidationStatus =
  | 'VALID'
  | 'INVALID_JSON'
  | 'SCHEMA_ERROR'
  | 'UNKNOWN_EVIDENCE'
  | 'UNSAFE'
  | 'INCOMPLETE'
  | 'PROVIDER_ERROR';

export interface EngineAssessment {
  verdict: EngineVerdict;
  /** Engine score, integer from 0 to 100. */
  score: number;
  /** IDs of the engine evidence (`ev1..evN`). Without them there is no escalation. */
  evidenceIds?: readonly string[];
  /** Fact taken from the human trust repository, never from the AI. */
  userAllowlisted?: boolean;
}

/** Latest AI analysis of the result, already passed through `AIResponseValidator`. */
export type PolicyAIAnalysis =
  | {
      validationStatus: 'VALID';
      opinion: AIOpinion;
      confidence: number;
      citedEvidenceIds: readonly string[];
    }
  | { validationStatus: Exclude<AIValidationStatus, 'VALID'> };

export interface RiskDecision {
  policyVersion: typeof POLICY_VERSION;
  engineVerdict: EngineVerdict;
  engineScore: number;
  /** Only filled in with a valid analysis; otherwise `null`. */
  aiOpinion: AIOpinion | null;
  aiConfidence: number | null;
  finalVerdict: EngineVerdict;
  finalLevel: RiskLevel;
  reviewRequired: boolean;
  origin: RiskOrigin;
  rule: PolicyRule;
  /** The AI is absent or was discarded: show `AI_PENDING_LABEL`. */
  aiPending: boolean;
  /** Readable decision steps, in order. Stored as `trace_json`. */
  trace: string[];
}

type ValidAIAnalysis = Extract<PolicyAIAnalysis, { validationStatus: 'VALID' }>;

const VERDICTS: ReadonlySet<string> = new Set([
  'CLEAN',
  'SUSPICIOUS',
  'DETECTED',
]);
const OPINIONS: ReadonlySet<string> = new Set([
  'LIKELY_BENIGN',
  'SUSPICIOUS',
  'LIKELY_MALICIOUS',
  'INSUFFICIENT_EVIDENCE',
]);

/** Level by score: 0–29 BAJO · 30–59 MEDIO · 60–84 ALTO · 85–100 CRÍTICO. */
export function levelForScore(score: number): RiskLevel {
  if (score < 30) return 'BAJO';
  if (score < 60) return 'MEDIO';
  if (score < 85) return 'ALTO';
  return 'CRÍTICO';
}

// Defense: even when it arrives as VALID, an impossible opinion or confidence is not trusted.
function isWithinRange(ai: ValidAIAnalysis): boolean {
  return (
    OPINIONS.has(ai.opinion) &&
    Number.isFinite(ai.confidence) &&
    ai.confidence >= 0 &&
    ai.confidence <= 1 &&
    Array.isArray(ai.citedEvidenceIds)
  );
}

/** Checks, one by one, the CLEAN → SUSPICIOUS escalation conditions. */
function escalationChecks(
  score: number,
  evidenceIds: readonly string[],
  ai: ValidAIAnalysis,
): Array<[ok: boolean, text: string]> {
  const known = new Set(evidenceIds);
  const existing = ai.citedEvidenceIds.filter((id) => known.has(id));
  const invented = ai.citedEvidenceIds.filter((id) => !known.has(id));
  return [
    [
      ai.opinion === 'SUSPICIOUS' || ai.opinion === 'LIKELY_MALICIOUS',
      `opinión SUSPICIOUS o LIKELY_MALICIOUS (es ${ai.opinion})`,
    ],
    [
      ai.confidence >= ESCALATION_MIN_CONFIDENCE,
      `confianza ≥ ${ESCALATION_MIN_CONFIDENCE} (es ${ai.confidence})`,
    ],
    [
      existing.length >= 1 && invented.length === 0,
      invented.length > 0
        ? `cita solo evidencias existentes (cita inexistentes: ${invented.join(', ')})`
        : `cita al menos una evidencia existente (cita ${existing.length})`,
    ],
    [score > 0, `puntuación del motor > 0 (es ${score})`],
  ];
}

/**
 * RiskPolicy v3 (ADR-006). First the human decision by hash; then the v2 rules:
 * - the AI never produces DETECTED nor lowers a verdict;
 * - it can only escalate CLEAN → SUSPICIOUS if ALL plan conditions hold, and
 *   then the level stays at MEDIO at most and the origin is AI_ESCALATION;
 * - on SUSPICIOUS, an AI LIKELY_BENIGN with confidence ≥ 0.8 only requests human review.
 */
export function decideRisk(
  engine: EngineAssessment,
  ai?: PolicyAIAnalysis | null,
): RiskDecision {
  if (!VERDICTS.has(engine.verdict)) {
    throw new RangeError(
      `RiskPolicy only evaluates CLEAN, SUSPICIOUS or DETECTED (received: ${String(engine.verdict)}).`,
    );
  }
  if (
    !Number.isInteger(engine.score) ||
    engine.score < 0 ||
    engine.score > 100
  ) {
    throw new RangeError(
      `The engine score must be an integer from 0 to 100 (received: ${String(engine.score)}).`,
    );
  }

  const trace: string[] = [];
  const { verdict, score } = engine;
  // Shape validation precedes the rules; the allowlist precedes ANY verdict/AI.
  if (engine.userAllowlisted === true) {
    return {
      policyVersion: POLICY_VERSION,
      engineVerdict: verdict,
      engineScore: score,
      aiOpinion: null,
      aiConfidence: null,
      finalVerdict: 'CLEAN',
      finalLevel: 'BAJO',
      reviewRequired: false,
      origin: 'USER_ALLOWLIST',
      rule: 'USER_ALLOWLIST',
      aiPending: false,
      trace: [
        'El usuario confía explícitamente en este SHA-256 (allowlist).',
        `Motor conservado para auditoría: ${verdict}, ${score} puntos.`,
        'Veredicto final CLEAN, nivel BAJO; decisión humana anterior a cualquier opinión de IA.',
      ],
    };
  }
  trace.push(`Motor: veredicto ${verdict} con ${score} puntos.`);

  let finalLevel = levelForScore(score);
  if (verdict === 'DETECTED' && finalLevel !== 'CRÍTICO') {
    finalLevel = 'CRÍTICO';
    trace.push(
      `DETECTED implica nivel CRÍTICO, aunque la puntuación (${score}) sea menor que 85.`,
    );
  } else {
    trace.push(`Nivel ${finalLevel} según la puntuación.`);
  }

  // 1. Is there a usable AI?
  let usable: ValidAIAnalysis | null = null;
  if (ai == null) {
    trace.push(
      `IA ausente: se mantiene el veredicto del motor (${AI_PENDING_LABEL}).`,
    );
  } else if (ai.validationStatus !== 'VALID') {
    trace.push(
      `IA descartada (${ai.validationStatus}): se mantiene el veredicto del motor (${AI_PENDING_LABEL}).`,
    );
  } else if (!isWithinRange(ai)) {
    trace.push(
      `IA descartada (datos fuera de rango): se mantiene el veredicto del motor (${AI_PENDING_LABEL}).`,
    );
  } else {
    usable = ai;
    trace.push(
      `IA válida: opina ${ai.opinion} con confianza ${ai.confidence}.`,
    );
  }

  // 2. Rules by engine verdict.
  let finalVerdict: EngineVerdict = verdict;
  let origin: RiskOrigin = 'ENGINE';
  let reviewRequired = false;
  let rule: PolicyRule;

  if (verdict === 'DETECTED') {
    rule = 'DETECTED_KEPT';
    trace.push(
      'Regla DETECTED: se mantiene DETECTED; la IA nunca baja un veredicto.',
    );
  } else if (verdict === 'SUSPICIOUS') {
    if (
      usable?.opinion === 'LIKELY_BENIGN' &&
      usable.confidence >= FALSE_POSITIVE_REVIEW_MIN_CONFIDENCE
    ) {
      rule = 'SUSPICIOUS_POSSIBLE_FALSE_POSITIVE';
      reviewRequired = true;
      trace.push(
        `Regla SUSPICIOUS: la IA opina LIKELY_BENIGN con confianza ≥ ${FALSE_POSITIVE_REVIEW_MIN_CONFIDENCE}: se mantiene SUSPICIOUS y se pide revisión (posible falso positivo).`,
      );
    } else {
      rule = 'SUSPICIOUS_KEPT';
      trace.push(
        'Regla SUSPICIOUS: se mantiene SUSPICIOUS; la IA nunca baja un veredicto.',
      );
    }
  } else if (usable === null) {
    rule = 'CLEAN_KEPT';
    trace.push('Regla CLEAN: sin IA válida no hay escalamiento.');
  } else {
    const checks = escalationChecks(score, engine.evidenceIds ?? [], usable);
    for (const [ok, text] of checks) {
      trace.push(
        `Condición de escalamiento ${ok ? 'cumplida' : 'NO cumplida'}: ${text}.`,
      );
    }
    if (checks.every(([ok]) => ok)) {
      rule = 'CLEAN_ESCALATED_BY_AI';
      finalVerdict = 'SUSPICIOUS';
      origin = 'AI_ESCALATION';
      finalLevel = ESCALATION_LEVEL;
      trace.push(
        `Regla CLEAN: se cumplen todas las condiciones: se escala a SUSPICIOUS con nivel ${ESCALATION_LEVEL} (origen AI_ESCALATION, «Escalado por IA»).`,
      );
    } else {
      rule = 'CLEAN_KEPT';
      trace.push(
        'Regla CLEAN: falta al menos una condición: se mantiene CLEAN.',
      );
    }
  }

  trace.push(
    `Veredicto final: ${finalVerdict}, nivel ${finalLevel} (origen ${origin}).`,
  );

  return {
    policyVersion: POLICY_VERSION,
    engineVerdict: verdict,
    engineScore: score,
    aiOpinion: usable?.opinion ?? null,
    aiConfidence: usable?.confidence ?? null,
    finalVerdict,
    finalLevel,
    reviewRequired,
    origin,
    rule,
    aiPending: usable === null,
    trace,
  };
}

// Solo importaciones de tipos: este archivo también se ejecuta con el type stripping de Node
// (cobertura nativa en tests/risk-policy.cases.mjs).
import type { AIAssessment } from '../ai/schemas';
import type { RiskLevel } from '../persistence/assessmentTypes';

export const POLICY_VERSION = '3';
export const AI_PENDING_LABEL = 'IA pendiente / no disponible';

/** Umbrales de la política v2 (plan S3, sección «RiskPolicy v2»). */
export const ESCALATION_MIN_CONFIDENCE = 0.7;
export const FALSE_POSITIVE_REVIEW_MIN_CONFIDENCE = 0.8;
/** Nivel máximo que puede alcanzar un resultado escalado por la IA. */
export const ESCALATION_LEVEL: RiskLevel = 'MEDIO';

/** Veredictos que la política evalúa. ERROR y NOT_ANALYZED no llegan aquí (no hay puntuación). */
export type EngineVerdict = 'CLEAN' | 'SUSPICIOUS' | 'DETECTED';
export type AIOpinion = AIAssessment['opinion'];
export type RiskOrigin = 'ENGINE' | 'AI_ESCALATION' | 'USER_ALLOWLIST';

/** Regla de la política que decidió el resultado (para el panel «¿Cómo se decidió?»). */
export type PolicyRule =
  | 'USER_ALLOWLIST'
  | 'DETECTED_KEPT'
  | 'SUSPICIOUS_KEPT'
  | 'SUSPICIOUS_POSSIBLE_FALSE_POSITIVE'
  | 'CLEAN_ESCALATED_BY_AI'
  | 'CLEAN_KEPT';

/** Mismos valores que `ai_analyses.validation_status`. */
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
  /** Puntuación del motor, entero de 0 a 100. */
  score: number;
  /** IDs de las evidencias del motor (`ev1..evN`). Sin ellos no se puede escalar. */
  evidenceIds?: readonly string[];
  /** Hecho obtenido del repositorio de confianza humana, nunca de la IA. */
  userAllowlisted?: boolean;
}

/** Último análisis de IA del resultado, ya pasado por `AIResponseValidator`. */
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
  /** Solo se rellenan con un análisis válido; si no, `null`. */
  aiOpinion: AIOpinion | null;
  aiConfidence: number | null;
  finalVerdict: EngineVerdict;
  finalLevel: RiskLevel;
  reviewRequired: boolean;
  origin: RiskOrigin;
  rule: PolicyRule;
  /** La IA está ausente o se descartó: mostrar `AI_PENDING_LABEL`. */
  aiPending: boolean;
  /** Pasos legibles de la decisión, en orden. Se guarda como `trace_json`. */
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

/** Nivel por puntuación: 0–29 BAJO · 30–59 MEDIO · 60–84 ALTO · 85–100 CRÍTICO. */
export function levelForScore(score: number): RiskLevel {
  if (score < 30) return 'BAJO';
  if (score < 60) return 'MEDIO';
  if (score < 85) return 'ALTO';
  return 'CRÍTICO';
}

// Defensa: aunque llegue como VALID, no se confía en una opinión o confianza imposibles.
function isWithinRange(ai: ValidAIAnalysis): boolean {
  return (
    OPINIONS.has(ai.opinion) &&
    Number.isFinite(ai.confidence) &&
    ai.confidence >= 0 &&
    ai.confidence <= 1 &&
    Array.isArray(ai.citedEvidenceIds)
  );
}

/** Comprueba, una a una, las condiciones del escalamiento CLEAN → SUSPICIOUS. */
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
 * RiskPolicy v3 (ADR-006). Primero la decisión humana por hash; luego las reglas v2:
 * - la IA nunca produce DETECTED ni baja un veredicto;
 * - solo puede escalar CLEAN → SUSPICIOUS si se cumplen TODAS las condiciones del plan, y
 *   entonces el nivel queda en MEDIO como máximo y el origen es AI_ESCALATION;
 * - sobre SUSPICIOUS, una IA LIKELY_BENIGN con confianza ≥ 0.8 solo pide revisión humana.
 */
export function decideRisk(
  engine: EngineAssessment,
  ai?: PolicyAIAnalysis | null,
): RiskDecision {
  if (!VERDICTS.has(engine.verdict)) {
    throw new RangeError(
      `RiskPolicy solo evalúa CLEAN, SUSPICIOUS o DETECTED (recibido: ${String(engine.verdict)}).`,
    );
  }
  if (
    !Number.isInteger(engine.score) ||
    engine.score < 0 ||
    engine.score > 100
  ) {
    throw new RangeError(
      `La puntuación del motor debe ser un entero de 0 a 100 (recibido: ${String(engine.score)}).`,
    );
  }

  const trace: string[] = [];
  const { verdict, score } = engine;
  // La validación de forma precede a las reglas; la allowlist precede a TODO veredicto/IA.
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

  // 1. ¿Hay una IA utilizable?
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

  // 2. Reglas por veredicto del motor.
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

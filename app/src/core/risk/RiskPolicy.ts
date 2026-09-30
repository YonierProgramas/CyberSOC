// Solo importaciones de tipos: este archivo también se ejecuta con el type stripping de Node
// (cobertura nativa en tests/risk-policy.cases.mjs).
import type { AIAssessment } from '../ai/schemas';
import type { RiskLevel } from '../persistence/assessmentTypes';

export const POLICY_VERSION = '1';
export const AI_PENDING_LABEL = 'IA pendiente / no disponible';

/** Veredictos que la política evalúa. ERROR y NOT_ANALYZED no llegan aquí (no hay puntuación). */
export type EngineVerdict = 'CLEAN' | 'SUSPICIOUS' | 'DETECTED';
export type AIOpinion = AIAssessment['opinion'];
export type RiskOrigin = 'ENGINE' | 'AI_ESCALATION' | 'USER_ALLOWLIST';

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
}

/** Último análisis de IA del resultado, ya pasado por `AIResponseValidator`. */
export type PolicyAIAnalysis =
  | { validationStatus: 'VALID'; opinion: AIOpinion; confidence: number }
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
  /** La IA está ausente o se descartó: mostrar `AI_PENDING_LABEL`. */
  aiPending: boolean;
  /** Pasos legibles de la decisión, en orden. Se guarda como `trace_json`. */
  trace: string[];
}

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

type ValidAIAnalysis = Extract<PolicyAIAnalysis, { validationStatus: 'VALID' }>;

// Defensa: aunque llegue como VALID, no se confía en una opinión o confianza imposibles.
function isWithinRange(ai: ValidAIAnalysis): boolean {
  return (
    OPINIONS.has(ai.opinion) &&
    Number.isFinite(ai.confidence) &&
    ai.confidence >= 0 &&
    ai.confidence <= 1
  );
}

/**
 * RiskPolicy v1. Función pura: el veredicto final es siempre el del motor. La IA válida solo
 * puede activar `reviewRequired` cuando contradice al motor; nunca cambia el veredicto ni el
 * nivel. El escalamiento CLEAN → SUSPICIOUS llega en v2 (S3).
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

  let reviewRequired = false;
  let aiPending = false;
  let aiOpinion: AIOpinion | null = null;
  let aiConfidence: number | null = null;

  if (ai == null) {
    aiPending = true;
    trace.push(
      `IA ausente: se mantiene el veredicto del motor (${AI_PENDING_LABEL}).`,
    );
  } else if (ai.validationStatus !== 'VALID') {
    aiPending = true;
    trace.push(
      `IA descartada (${ai.validationStatus}): se mantiene el veredicto del motor (${AI_PENDING_LABEL}).`,
    );
  } else if (!isWithinRange(ai)) {
    aiPending = true;
    trace.push(
      `IA descartada (datos fuera de rango): se mantiene el veredicto del motor (${AI_PENDING_LABEL}).`,
    );
  } else {
    aiOpinion = ai.opinion;
    aiConfidence = ai.confidence;
    trace.push(
      `IA válida: opina ${ai.opinion} con confianza ${ai.confidence}.`,
    );
    const benignOverRisk =
      ai.opinion === 'LIKELY_BENIGN' && verdict !== 'CLEAN';
    const riskOverClean =
      verdict === 'CLEAN' &&
      (ai.opinion === 'SUSPICIOUS' || ai.opinion === 'LIKELY_MALICIOUS');
    if (benignOverRisk || riskOverClean) {
      reviewRequired = true;
      trace.push(
        `La IA contradice al motor (${ai.opinion} sobre ${verdict}): se requiere revisión.`,
      );
    } else if (ai.opinion === 'INSUFFICIENT_EVIDENCE') {
      trace.push('La IA no tiene evidencia suficiente: no requiere revisión.');
    } else {
      trace.push(
        `La IA es coherente con el motor (${ai.opinion} sobre ${verdict}).`,
      );
    }
  }

  trace.push(
    `Veredicto final: ${verdict} (origen ENGINE). En la política v1 la IA nunca cambia el veredicto.`,
  );

  return {
    policyVersion: POLICY_VERSION,
    engineVerdict: verdict,
    engineScore: score,
    aiOpinion,
    aiConfidence,
    finalVerdict: verdict,
    finalLevel,
    reviewRequired,
    origin: 'ENGINE',
    aiPending,
    trace,
  };
}

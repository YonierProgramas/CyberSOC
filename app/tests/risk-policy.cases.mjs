import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AI_PENDING_LABEL,
  POLICY_VERSION,
  decideRisk,
  levelForScore,
} from '../src/core/risk/RiskPolicy.ts';

// Tabla de casos de RiskPolicy v2, escrita a partir del plan de S3 («RiskPolicy v2»),
// no de la implementación. Columnas:
// nombre · motor · IA · veredicto final · nivel final · origen · regla · revisión · IA pendiente.
const EV = ['ev1', 'ev2'];
const valid = (opinion, confidence = 0.9, cited = ['ev1']) => ({
  validationStatus: 'VALID',
  opinion,
  confidence,
  citedEvidenceIds: cited,
});
const clean = (score = 25, evidenceIds = EV) => ({
  verdict: 'CLEAN',
  score,
  evidenceIds,
});
const suspicious = { verdict: 'SUSPICIOUS', score: 40, evidenceIds: EV };
const detected = { verdict: 'DETECTED', score: 100, evidenceIds: EV };

const cases = [
  // --- IA ausente o inválida: el motor decide y se etiqueta «IA pendiente». ---
  [
    'CLEAN sin IA (undefined)',
    clean(0),
    undefined,
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],
  [
    'CLEAN sin IA (null)',
    clean(29),
    null,
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],
  [
    'SUSPICIOUS sin IA',
    suspicious,
    null,
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_KEPT',
    false,
    true,
  ],
  [
    'SUSPICIOUS 60 sin IA',
    { ...suspicious, score: 60 },
    null,
    'SUSPICIOUS',
    'ALTO',
    'ENGINE',
    'SUSPICIOUS_KEPT',
    false,
    true,
  ],
  [
    'DETECTED sin IA',
    detected,
    null,
    'DETECTED',
    'CRÍTICO',
    'ENGINE',
    'DETECTED_KEPT',
    false,
    true,
  ],
  [
    'DETECTED 40 fuerza CRÍTICO',
    { ...detected, score: 40 },
    null,
    'DETECTED',
    'CRÍTICO',
    'ENGINE',
    'DETECTED_KEPT',
    false,
    true,
  ],
  ...[
    'INVALID_JSON',
    'SCHEMA_ERROR',
    'UNKNOWN_EVIDENCE',
    'UNSAFE',
    'INCOMPLETE',
    'PROVIDER_ERROR',
  ].map((status) => [
    `IA ${status} sobre CLEAN: no escala`,
    clean(),
    { validationStatus: status },
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ]),
  // «VALID» con datos imposibles: se descarta como inválida.
  [
    'IA con opinión fuera del enum',
    clean(),
    valid('MALICIOUS'),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],
  [
    'IA con confianza NaN',
    clean(),
    valid('SUSPICIOUS', Number.NaN),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],
  [
    'IA con confianza negativa',
    clean(),
    valid('SUSPICIOUS', -0.1),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],
  [
    'IA con confianza mayor que 1',
    clean(),
    valid('SUSPICIOUS', 1.1),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],
  [
    'IA sin citedEvidenceIds',
    clean(),
    { validationStatus: 'VALID', opinion: 'SUSPICIOUS', confidence: 0.9 },
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    true,
  ],

  // --- DETECTED: siempre DETECTED; la IA nunca baja un veredicto. ---
  [
    'DETECTED + LIKELY_BENIGN 0.99',
    detected,
    valid('LIKELY_BENIGN', 0.99),
    'DETECTED',
    'CRÍTICO',
    'ENGINE',
    'DETECTED_KEPT',
    false,
    false,
  ],
  [
    'DETECTED + SUSPICIOUS',
    detected,
    valid('SUSPICIOUS'),
    'DETECTED',
    'CRÍTICO',
    'ENGINE',
    'DETECTED_KEPT',
    false,
    false,
  ],
  [
    'DETECTED + LIKELY_MALICIOUS',
    detected,
    valid('LIKELY_MALICIOUS', 1),
    'DETECTED',
    'CRÍTICO',
    'ENGINE',
    'DETECTED_KEPT',
    false,
    false,
  ],
  [
    'DETECTED + INSUFFICIENT_EVIDENCE',
    detected,
    valid('INSUFFICIENT_EVIDENCE', 0, []),
    'DETECTED',
    'CRÍTICO',
    'ENGINE',
    'DETECTED_KEPT',
    false,
    false,
  ],

  // --- SUSPICIOUS: siempre SUSPICIOUS; revisión solo con LIKELY_BENIGN y confianza ≥ 0.8. ---
  [
    'SUSPICIOUS + LIKELY_BENIGN 0.80 → revisión',
    suspicious,
    valid('LIKELY_BENIGN', 0.8),
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_POSSIBLE_FALSE_POSITIVE',
    true,
    false,
  ],
  [
    'SUSPICIOUS + LIKELY_BENIGN 1.00 → revisión',
    suspicious,
    valid('LIKELY_BENIGN', 1),
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_POSSIBLE_FALSE_POSITIVE',
    true,
    false,
  ],
  [
    'SUSPICIOUS + LIKELY_BENIGN 0.79 → sin revisión',
    suspicious,
    valid('LIKELY_BENIGN', 0.79),
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_KEPT',
    false,
    false,
  ],
  [
    'SUSPICIOUS + SUSPICIOUS',
    suspicious,
    valid('SUSPICIOUS'),
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_KEPT',
    false,
    false,
  ],
  [
    'SUSPICIOUS + LIKELY_MALICIOUS 1.00 (no sube a DETECTED)',
    suspicious,
    valid('LIKELY_MALICIOUS', 1),
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_KEPT',
    false,
    false,
  ],
  [
    'SUSPICIOUS + INSUFFICIENT_EVIDENCE',
    suspicious,
    valid('INSUFFICIENT_EVIDENCE', 0.9, []),
    'SUSPICIOUS',
    'MEDIO',
    'ENGINE',
    'SUSPICIOUS_KEPT',
    false,
    false,
  ],

  // --- CLEAN: escalamiento solo con TODAS las condiciones. ---
  [
    'CLEAN + SUSPICIOUS 0.70, cita ev1, 25 pts → escala',
    clean(25),
    valid('SUSPICIOUS', 0.7),
    'SUSPICIOUS',
    'MEDIO',
    'AI_ESCALATION',
    'CLEAN_ESCALATED_BY_AI',
    false,
    false,
  ],
  [
    'CLEAN + LIKELY_MALICIOUS 1.00, 1 pt → escala con nivel MEDIO',
    clean(1),
    valid('LIKELY_MALICIOUS', 1, ['ev1', 'ev2']),
    'SUSPICIOUS',
    'MEDIO',
    'AI_ESCALATION',
    'CLEAN_ESCALATED_BY_AI',
    false,
    false,
  ],
  // Límite de confianza.
  [
    'CLEAN + SUSPICIOUS 0.69 → no escala',
    clean(25),
    valid('SUSPICIOUS', 0.69),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  // Límite de puntuación.
  [
    'CLEAN puntuación 0 + LIKELY_MALICIOUS 1.00 → no escala',
    clean(0),
    valid('LIKELY_MALICIOUS', 1),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  // Citas.
  [
    'CLEAN + SUSPICIOUS sin citas → no escala',
    clean(25),
    valid('SUSPICIOUS', 0.9, []),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  [
    'CLEAN + SUSPICIOUS con cita inexistente → no escala',
    clean(25),
    valid('SUSPICIOUS', 0.9, ['ev9']),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  [
    'CLEAN + SUSPICIOUS con una cita real y otra inventada → no escala',
    clean(25),
    valid('SUSPICIOUS', 0.9, ['ev1', 'ev9']),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  [
    'CLEAN sin ids de evidencia del motor → no escala',
    { verdict: 'CLEAN', score: 25 },
    valid('SUSPICIOUS', 0.9),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  // Opinión.
  [
    'CLEAN + LIKELY_BENIGN → no escala',
    clean(25),
    valid('LIKELY_BENIGN', 0.9),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
  [
    'CLEAN + INSUFFICIENT_EVIDENCE → no escala',
    clean(25),
    valid('INSUFFICIENT_EVIDENCE', 0.9, []),
    'CLEAN',
    'BAJO',
    'ENGINE',
    'CLEAN_KEPT',
    false,
    false,
  ],
];

describe('RiskPolicy v2: tabla de casos', () => {
  for (const [
    name,
    engine,
    ai,
    verdict,
    level,
    origin,
    rule,
    review,
    pending,
  ] of cases) {
    it(name, () => {
      const input = structuredClone({ engine, ai });
      const decision = decideRisk(engine, ai);

      assert.equal(decision.policyVersion, POLICY_VERSION);
      assert.equal(decision.engineVerdict, engine.verdict);
      assert.equal(decision.engineScore, engine.score);
      assert.equal(decision.finalVerdict, verdict);
      assert.equal(decision.finalLevel, level);
      assert.equal(decision.origin, origin);
      assert.equal(decision.rule, rule);
      assert.equal(decision.reviewRequired, review);
      assert.equal(decision.aiPending, pending);

      // Nunca DETECTED por la IA, nunca un veredicto más bajo que el del motor.
      if (engine.verdict !== 'DETECTED')
        assert.notEqual(decision.finalVerdict, 'DETECTED');
      if (engine.verdict !== 'CLEAN')
        assert.equal(decision.finalVerdict, engine.verdict);

      // Opinión y confianza solo se registran si la IA es válida.
      if (pending) {
        assert.equal(decision.aiOpinion, null);
        assert.equal(decision.aiConfidence, null);
      } else {
        assert.equal(decision.aiOpinion, ai.opinion);
        assert.equal(decision.aiConfidence, ai.confidence);
      }

      // Traza: empieza por el motor, nombra la regla aplicada y termina con el resultado.
      assert.match(
        decision.trace[0],
        new RegExp(`^Motor: veredicto ${engine.verdict}`),
      );
      assert.ok(
        decision.trace.some((step) =>
          step.startsWith(`Regla ${engine.verdict}`),
        ),
      );
      assert.match(
        decision.trace.at(-1),
        new RegExp(
          `^Veredicto final: ${verdict}, nivel ${level} \\(origen ${origin}\\)`,
        ),
      );
      assert.equal(
        decision.trace.some((step) => step.includes(AI_PENDING_LABEL)),
        pending,
      );
      // Con IA válida sobre CLEAN, la traza muestra las 4 condiciones y cuál falló.
      if (engine.verdict === 'CLEAN' && !pending) {
        const conditions = decision.trace.filter((step) =>
          step.startsWith('Condición de escalamiento'),
        );
        assert.equal(conditions.length, 4);
        assert.equal(
          conditions.every(
            (step) =>
              step.includes('cumplida:') && !step.includes('NO cumplida'),
          ),
          origin === 'AI_ESCALATION',
        );
      }

      // Pura: no modifica la entrada y repite el mismo resultado.
      assert.deepEqual({ engine, ai }, input);
      assert.deepEqual(decideRisk(engine, ai), decision);
    });
  }
});

describe('RiskPolicy v2: entradas que no evalúa', () => {
  for (const [name, engine] of [
    ['veredicto ERROR', { verdict: 'ERROR', score: 0 }],
    ['veredicto NOT_ANALYZED', { verdict: 'NOT_ANALYZED', score: 0 }],
    ['puntuación decimal', { verdict: 'CLEAN', score: 1.5 }],
    ['puntuación negativa', { verdict: 'CLEAN', score: -1 }],
    ['puntuación mayor que 100', { verdict: 'DETECTED', score: 101 }],
    ['puntuación NaN', { verdict: 'CLEAN', score: Number.NaN }],
  ]) {
    it(`lanza RangeError: ${name}`, () => {
      assert.throws(
        () => decideRisk(engine, valid('LIKELY_BENIGN')),
        RangeError,
      );
    });
  }
});

describe('RiskPolicy v3: prioridad de la confianza humana', () => {
  for (const verdict of ['CLEAN', 'SUSPICIOUS', 'DETECTED']) {
    it(`allowlist sobre ${verdict} conserva hechos y decide CLEAN`, () => {
      const result = decideRisk(
        { verdict, score: 100, userAllowlisted: true },
        valid('LIKELY_MALICIOUS'),
      );
      assert.equal(result.policyVersion, '3');
      assert.equal(result.finalVerdict, 'CLEAN');
      assert.equal(result.finalLevel, 'BAJO');
      assert.equal(result.origin, 'USER_ALLOWLIST');
      assert.equal(result.rule, 'USER_ALLOWLIST');
      assert.equal(result.engineVerdict, verdict);
      assert.equal(result.aiOpinion, null);
      assert.equal(result.aiPending, false);
    });
  }
});

describe('levelForScore', () => {
  for (const [score, level] of [
    [0, 'BAJO'],
    [29, 'BAJO'],
    [30, 'MEDIO'],
    [59, 'MEDIO'],
    [60, 'ALTO'],
    [84, 'ALTO'],
    [85, 'CRÍTICO'],
    [100, 'CRÍTICO'],
  ]) {
    it(`${score} → ${level}`, () => assert.equal(levelForScore(score), level));
  }
});

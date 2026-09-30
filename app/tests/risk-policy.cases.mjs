import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AI_PENDING_LABEL,
  POLICY_VERSION,
  decideRisk,
  levelForScore,
} from '../src/core/risk/RiskPolicy.ts';

// Tabla de casos de RiskPolicy v1, escrita a partir del plan de S2 y no de la implementación.
// Columnas: nombre, motor, IA, nivel esperado, revisión esperada, IA pendiente esperada.
const valid = (opinion, confidence = 0.8) => ({
  validationStatus: 'VALID',
  opinion,
  confidence,
});

const cases = [
  // Sin IA: el motor decide y se etiqueta "IA pendiente".
  [
    'CLEAN sin IA (undefined)',
    { verdict: 'CLEAN', score: 0 },
    undefined,
    'BAJO',
    false,
    true,
  ],
  [
    'CLEAN sin IA (null)',
    { verdict: 'CLEAN', score: 29 },
    null,
    'BAJO',
    false,
    true,
  ],
  [
    'SUSPICIOUS 30 sin IA',
    { verdict: 'SUSPICIOUS', score: 30 },
    null,
    'MEDIO',
    false,
    true,
  ],
  [
    'SUSPICIOUS 59 sin IA',
    { verdict: 'SUSPICIOUS', score: 59 },
    null,
    'MEDIO',
    false,
    true,
  ],
  [
    'SUSPICIOUS 60 sin IA',
    { verdict: 'SUSPICIOUS', score: 60 },
    null,
    'ALTO',
    false,
    true,
  ],
  [
    'SUSPICIOUS 84 sin IA',
    { verdict: 'SUSPICIOUS', score: 84 },
    null,
    'ALTO',
    false,
    true,
  ],
  [
    'DETECTED 85 sin IA',
    { verdict: 'DETECTED', score: 85 },
    null,
    'CRÍTICO',
    false,
    true,
  ],
  [
    'DETECTED 100 sin IA',
    { verdict: 'DETECTED', score: 100 },
    null,
    'CRÍTICO',
    false,
    true,
  ],
  // DETECTED implica nivel ≥ 85 aunque la puntuación no llegue.
  [
    'DETECTED 40 fuerza CRÍTICO',
    { verdict: 'DETECTED', score: 40 },
    null,
    'CRÍTICO',
    false,
    true,
  ],

  // IA inválida: igual que ausente.
  ...[
    'INVALID_JSON',
    'SCHEMA_ERROR',
    'UNKNOWN_EVIDENCE',
    'UNSAFE',
    'INCOMPLETE',
    'PROVIDER_ERROR',
  ].map((status) => [
    `IA ${status} sobre SUSPICIOUS`,
    { verdict: 'SUSPICIOUS', score: 40 },
    { validationStatus: status },
    'MEDIO',
    false,
    true,
  ]),
  // "VALID" con datos imposibles: se descarta, no se confía en la IA.
  [
    'IA con opinión fuera del enum',
    { verdict: 'CLEAN', score: 0 },
    valid('MALICIOUS'),
    'BAJO',
    false,
    true,
  ],
  [
    'IA con confianza NaN',
    { verdict: 'CLEAN', score: 0 },
    valid('SUSPICIOUS', Number.NaN),
    'BAJO',
    false,
    true,
  ],
  [
    'IA con confianza negativa',
    { verdict: 'CLEAN', score: 0 },
    valid('SUSPICIOUS', -0.1),
    'BAJO',
    false,
    true,
  ],
  [
    'IA con confianza mayor que 1',
    { verdict: 'CLEAN', score: 0 },
    valid('SUSPICIOUS', 1.1),
    'BAJO',
    false,
    true,
  ],

  // IA válida: matriz completa veredicto × opinión.
  [
    'CLEAN + LIKELY_BENIGN',
    { verdict: 'CLEAN', score: 10 },
    valid('LIKELY_BENIGN'),
    'BAJO',
    false,
    false,
  ],
  [
    'CLEAN + SUSPICIOUS',
    { verdict: 'CLEAN', score: 10 },
    valid('SUSPICIOUS'),
    'BAJO',
    true,
    false,
  ],
  [
    'CLEAN + LIKELY_MALICIOUS',
    { verdict: 'CLEAN', score: 10 },
    valid('LIKELY_MALICIOUS', 1),
    'BAJO',
    true,
    false,
  ],
  [
    'CLEAN + INSUFFICIENT_EVIDENCE',
    { verdict: 'CLEAN', score: 10 },
    valid('INSUFFICIENT_EVIDENCE', 0),
    'BAJO',
    false,
    false,
  ],
  [
    'SUSPICIOUS + LIKELY_BENIGN',
    { verdict: 'SUSPICIOUS', score: 40 },
    valid('LIKELY_BENIGN'),
    'MEDIO',
    true,
    false,
  ],
  [
    'SUSPICIOUS + SUSPICIOUS',
    { verdict: 'SUSPICIOUS', score: 40 },
    valid('SUSPICIOUS'),
    'MEDIO',
    false,
    false,
  ],
  [
    'SUSPICIOUS + LIKELY_MALICIOUS',
    { verdict: 'SUSPICIOUS', score: 40 },
    valid('LIKELY_MALICIOUS'),
    'MEDIO',
    false,
    false,
  ],
  [
    'SUSPICIOUS + INSUFFICIENT_EVIDENCE',
    { verdict: 'SUSPICIOUS', score: 40 },
    valid('INSUFFICIENT_EVIDENCE'),
    'MEDIO',
    false,
    false,
  ],
  [
    'DETECTED + LIKELY_BENIGN',
    { verdict: 'DETECTED', score: 100 },
    valid('LIKELY_BENIGN', 0.99),
    'CRÍTICO',
    true,
    false,
  ],
  [
    'DETECTED + SUSPICIOUS',
    { verdict: 'DETECTED', score: 100 },
    valid('SUSPICIOUS'),
    'CRÍTICO',
    false,
    false,
  ],
  [
    'DETECTED + LIKELY_MALICIOUS',
    { verdict: 'DETECTED', score: 100 },
    valid('LIKELY_MALICIOUS'),
    'CRÍTICO',
    false,
    false,
  ],
  [
    'DETECTED + INSUFFICIENT_EVIDENCE',
    { verdict: 'DETECTED', score: 100 },
    valid('INSUFFICIENT_EVIDENCE'),
    'CRÍTICO',
    false,
    false,
  ],
];

describe('RiskPolicy v1: tabla de casos', () => {
  for (const [name, engine, ai, level, review, pending] of cases) {
    it(name, () => {
      const input = structuredClone({ engine, ai });
      const decision = decideRisk(engine, ai);

      // La IA nunca cambia el veredicto ni el origen en v1.
      assert.equal(decision.finalVerdict, engine.verdict);
      assert.equal(decision.engineVerdict, engine.verdict);
      assert.equal(decision.engineScore, engine.score);
      assert.equal(decision.origin, 'ENGINE');
      assert.equal(decision.policyVersion, POLICY_VERSION);
      assert.equal(decision.finalLevel, level);
      assert.equal(decision.reviewRequired, review);
      assert.equal(decision.aiPending, pending);

      // Opinión y confianza solo se registran si la IA es válida.
      if (pending) {
        assert.equal(decision.aiOpinion, null);
        assert.equal(decision.aiConfidence, null);
      } else {
        assert.equal(decision.aiOpinion, ai.opinion);
        assert.equal(decision.aiConfidence, ai.confidence);
      }

      // Traza legible: empieza por el motor, termina con el veredicto final, y
      // lleva la etiqueta de IA pendiente cuando corresponde.
      assert.ok(decision.trace.length >= 3);
      assert.ok(
        decision.trace.every(
          (step) => typeof step === 'string' && step.length > 0,
        ),
      );
      assert.match(
        decision.trace[0],
        new RegExp(`^Motor: veredicto ${engine.verdict}`),
      );
      assert.match(
        decision.trace.at(-1),
        new RegExp(`^Veredicto final: ${engine.verdict}`),
      );
      assert.equal(
        decision.trace.some((step) => step.includes(AI_PENDING_LABEL)),
        pending,
      );
      assert.equal(
        decision.trace.some((step) => step.includes('se requiere revisión')),
        review,
      );

      // Pura: no modifica la entrada y repite el mismo resultado.
      assert.deepEqual({ engine, ai }, input);
      assert.deepEqual(decideRisk(engine, ai), decision);
    });
  }
});

describe('RiskPolicy v1: entradas que no evalúa', () => {
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

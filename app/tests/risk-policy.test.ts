import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import {
  decideRisk,
  type AIOpinion,
  type EngineVerdict,
  type PolicyAIAnalysis,
  type RiskDecision,
} from '../src/core/risk/RiskPolicy';

it('RiskPolicy: tabla de casos y cobertura nativa del 100 % de líneas, ramas y funciones', () => {
  // Cobertura nativa de Node: evita añadir un proveedor de cobertura como dependencia.
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-test-coverage',
      '--test-coverage-include=**/src/core/risk/RiskPolicy.ts',
      '--test-coverage-lines=100',
      '--test-coverage-branches=100',
      '--test-coverage-functions=100',
      '--test-reporter=tap',
      '--test',
      'tests/risk-policy.cases.mjs',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    },
  );
  // Evita que un informe vacío pase los umbrales sin medir nada.
  expect(output).toContain('RiskPolicy.ts');
  expect(output).toContain('# fail 0');
}, 25_000);

const EVIDENCE = ['ev1', 'ev2'];
const RANK: Record<EngineVerdict, number> = {
  CLEAN: 0,
  SUSPICIOUS: 1,
  DETECTED: 2,
};
const verdicts: EngineVerdict[] = ['CLEAN', 'SUSPICIOUS', 'DETECTED'];
const scores = [0, 1, 29, 30, 59, 60, 84, 85, 100];
const opinions: AIOpinion[] = [
  'LIKELY_BENIGN',
  'SUSPICIOUS',
  'LIKELY_MALICIOUS',
  'INSUFFICIENT_EVIDENCE',
];
const confidences = [0, 0.69, 0.7, 0.79, 0.8, 1];
const citations = [[], ['ev1'], ['ev9'], ['ev1', 'ev9'], ['ev1', 'ev2']];
const aiInputs: Array<PolicyAIAnalysis | null | undefined> = [
  undefined,
  null,
  { validationStatus: 'INVALID_JSON' },
  { validationStatus: 'SCHEMA_ERROR' },
  { validationStatus: 'UNKNOWN_EVIDENCE' },
  { validationStatus: 'UNSAFE' },
  { validationStatus: 'INCOMPLETE' },
  { validationStatus: 'PROVIDER_ERROR' },
  ...opinions.flatMap((opinion) =>
    confidences.flatMap((confidence) =>
      citations.map((citedEvidenceIds): PolicyAIAnalysis => ({
        validationStatus: 'VALID',
        opinion,
        confidence,
        citedEvidenceIds,
      })),
    ),
  ),
];

// Oráculo independiente de la implementación: las condiciones del plan, literalmente.
function shouldEscalate(
  verdict: EngineVerdict,
  score: number,
  ai: PolicyAIAnalysis | null | undefined,
): boolean {
  return (
    verdict === 'CLEAN' &&
    ai?.validationStatus === 'VALID' &&
    (ai.opinion === 'SUSPICIOUS' || ai.opinion === 'LIKELY_MALICIOUS') &&
    ai.confidence >= 0.7 &&
    ai.citedEvidenceIds.length >= 1 &&
    ai.citedEvidenceIds.every((id) => EVIDENCE.includes(id)) &&
    score > 0
  );
}

describe('RiskPolicy v2: invariantes sobre todas las combinaciones', () => {
  const combinations = verdicts.flatMap((verdict) =>
    scores.flatMap((score) => aiInputs.map((ai) => ({ verdict, score, ai }))),
  );
  const decide = (verdict: EngineVerdict, score: number, ai: unknown) =>
    decideRisk(
      { verdict, score, evidenceIds: EVIDENCE },
      ai as PolicyAIAnalysis | null | undefined,
    );

  it(`la IA nunca produce DETECTED ni baja un veredicto (${combinations.length} combinaciones)`, () => {
    for (const { verdict, score, ai } of combinations) {
      const decision = decide(verdict, score, ai);
      if (verdict !== 'DETECTED')
        expect(decision.finalVerdict).not.toBe('DETECTED');
      expect(RANK[decision.finalVerdict]).toBeGreaterThanOrEqual(RANK[verdict]);
    }
  });

  it('solo escala CLEAN → SUSPICIOUS con todas las condiciones, nivel MEDIO y origen AI_ESCALATION', () => {
    for (const { verdict, score, ai } of combinations) {
      const decision = decide(verdict, score, ai);
      if (shouldEscalate(verdict, score, ai)) {
        expect(decision).toMatchObject({
          finalVerdict: 'SUSPICIOUS',
          finalLevel: 'MEDIO',
          origin: 'AI_ESCALATION',
          rule: 'CLEAN_ESCALATED_BY_AI',
        });
      } else {
        expect(decision.finalVerdict).toBe(verdict);
        expect(decision.origin).toBe('ENGINE');
        // Sin escalamiento, el nivel es el mismo que sin IA.
        expect(decision.finalLevel).toBe(
          decide(verdict, score, null).finalLevel,
        );
      }
    }
  });

  it('la revisión solo se pide con SUSPICIOUS + LIKELY_BENIGN y confianza ≥ 0.8', () => {
    for (const { verdict, score, ai } of combinations) {
      const decision = decide(verdict, score, ai);
      const expected =
        verdict === 'SUSPICIOUS' &&
        ai?.validationStatus === 'VALID' &&
        ai.opinion === 'LIKELY_BENIGN' &&
        ai.confidence >= 0.8;
      expect(decision.reviewRequired).toBe(expected);
      expect(decision.aiPending).toBe(ai?.validationStatus !== 'VALID');
    }
  });

  it('DETECTED siempre queda en nivel CRÍTICO', () => {
    for (const score of scores) {
      expect(decideRisk({ verdict: 'DETECTED', score }).finalLevel).toBe(
        'CRÍTICO',
      );
    }
  });
});

describe('RiskPolicy v2 + RiskAssessmentRepository', () => {
  it('un escalamiento por IA se guarda tal cual en risk_assessments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cybersoc-risk-policy-'));
    const db = new Database(join(directory, 'riesgo.db'));
    try {
      new MigrationRunner(db).run();
      new ScanJobRepository(db).create({
        id: 'job',
        targetPath: 'C:\\carpeta',
        targetKind: 'FOLDER',
      });
      const decision: RiskDecision = decideRisk(
        { verdict: 'CLEAN', score: 25, evidenceIds: ['ev1'] },
        {
          validationStatus: 'VALID',
          opinion: 'LIKELY_MALICIOUS',
          confidence: 0.85,
          citedEvidenceIds: ['ev1'],
        },
      );
      const stored = new ScanResultRepository(db).insertComplete({
        result: {
          id: 'r1',
          jobId: 'job',
          seq: 0,
          path: 'C:\\carpeta\\factura.pdf.exe',
          fileName: 'factura.pdf.exe',
          status: 'SCANNED',
        },
        evidence: [
          {
            id: 'ev1',
            source: 'FILETYPE',
            code: 'DOUBLE_EXTENSION',
            title: 'Doble extensión',
            severity: 'HIGH',
            points: 25,
            decisive: false,
            confidence: 0.8,
            facts: {},
          },
        ],
        layers: [],
        assessment: {
          engineVerdict: decision.engineVerdict,
          engineScore: decision.engineScore,
          aiOpinion: decision.aiOpinion,
          aiConfidence: decision.aiConfidence,
          finalVerdict: decision.finalVerdict,
          finalLevel: decision.finalLevel,
          reviewRequired: decision.reviewRequired,
          origin: decision.origin,
          traceJson: JSON.stringify(decision.trace),
          policyVersion: decision.policyVersion,
        },
      });
      expect(stored).toMatchObject({
        verdict: 'SUSPICIOUS',
        engineScore: 25,
        riskLevel: 'MEDIO',
      });
      const row = db
        .prepare('SELECT * FROM risk_assessments WHERE result_id = ?')
        .get('r1');
      expect(row).toMatchObject({
        engine_verdict: 'CLEAN',
        ai_opinion: 'LIKELY_MALICIOUS',
        final_verdict: 'SUSPICIOUS',
        final_level: 'MEDIO',
        review_required: 0,
        origin: 'AI_ESCALATION',
        policy_version: '2',
      });
      expect(JSON.parse(String(row!.trace_json))).toEqual(decision.trace);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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

const verdicts: EngineVerdict[] = ['CLEAN', 'SUSPICIOUS', 'DETECTED'];
const scores = [0, 29, 30, 59, 60, 84, 85, 100];
const opinions: AIOpinion[] = [
  'LIKELY_BENIGN',
  'SUSPICIOUS',
  'LIKELY_MALICIOUS',
  'INSUFFICIENT_EVIDENCE',
];
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
    [0, 0.5, 1].map((confidence): PolicyAIAnalysis => ({
      validationStatus: 'VALID',
      opinion,
      confidence,
    })),
  ),
];

describe('RiskPolicy v1: invariantes sobre todas las combinaciones', () => {
  const combinations = verdicts.flatMap((verdict) =>
    scores.flatMap((score) => aiInputs.map((ai) => ({ verdict, score, ai }))),
  );

  it(`la IA nunca cambia veredicto, nivel ni origen (${combinations.length} combinaciones)`, () => {
    for (const { verdict, score, ai } of combinations) {
      const withAI = decideRisk({ verdict, score }, ai);
      const withoutAI = decideRisk({ verdict, score });
      expect(withAI.finalVerdict).toBe(verdict);
      expect(withAI.origin).toBe('ENGINE');
      expect(withAI.finalLevel).toBe(withoutAI.finalLevel);
    }
  });

  it('solo una IA válida puede activar la revisión, y solo si contradice al motor', () => {
    for (const { verdict, score, ai } of combinations) {
      const decision = decideRisk({ verdict, score }, ai);
      const contradicts =
        ai?.validationStatus === 'VALID' &&
        ((ai.opinion === 'LIKELY_BENIGN' && verdict !== 'CLEAN') ||
          (verdict === 'CLEAN' &&
            (ai.opinion === 'SUSPICIOUS' ||
              ai.opinion === 'LIKELY_MALICIOUS')));
      expect(decision.reviewRequired).toBe(contradicts);
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

describe('RiskPolicy v1 + RiskAssessmentRepository', () => {
  it('la decisión se guarda tal cual en risk_assessments', () => {
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
        { verdict: 'SUSPICIOUS', score: 40 },
        {
          validationStatus: 'VALID',
          opinion: 'LIKELY_BENIGN',
          confidence: 0.7,
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
        evidence: [],
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
        engineScore: 40,
        riskLevel: 'MEDIO',
      });
      const row = db
        .prepare('SELECT * FROM risk_assessments WHERE result_id = ?')
        .get('r1');
      expect(row).toMatchObject({
        engine_verdict: 'SUSPICIOUS',
        ai_opinion: 'LIKELY_BENIGN',
        final_verdict: 'SUSPICIOUS',
        final_level: 'MEDIO',
        review_required: 1,
        origin: 'ENGINE',
        policy_version: '1',
      });
      expect(JSON.parse(String(row!.trace_json))).toEqual(decision.trace);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

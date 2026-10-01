import { afterEach, expect, it, vi } from 'vitest';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';
import { RiskAssessmentRepository } from '../src/core/persistence/RiskAssessmentRepository';
import { JobSummaryStore } from '../src/core/ai/JobSummaryStore';
import { createAIProvider } from '../src/main/composition-root';
import { decideRisk } from '../src/core/risk/RiskPolicy';
vi.mock('electron', async () => ({
  app: { getPath: (await import('node:os')).tmpdir },
  safeStorage: {},
}));
import { AIFlowHarness } from './fixtures/AIFlowHarness';

let harness: AIFlowHarness | undefined;
afterEach(async () => {
  await harness?.close();
  vi.unstubAllEnvs();
});

it('modo evidencia usa RiskPolicy v2 sin reescribir decisiones y genera JOB_SUMMARY válido', async () => {
  vi.stubEnv('CYBERSOC_EVIDENCE_MODE', '1');
  vi.stubEnv('CYBERSOC_EVIDENCE_SCENARIO', 'escalation');
  vi.stubEnv('CYBERSOC_EVIDENCE_LIVE', '0');
  vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', '');
  harness = new AIFlowHarness(() => createAIProvider(harness!.db));
  await harness.prepare();
  const { job, results } = await harness.scan(harness.lowScore);
  const result = results[0]!;
  harness.worker.start();
  const summaries = new JobSummaryStore(harness.db);
  await vi.waitFor(() => expect(summaries.status(job.id)).toBe('COMPLETED'), {
    timeout: 10_000,
  });
  const risk = new RiskAssessmentRepository(harness.db).get(result.id)!;
  const expected = decideRisk(
    { verdict: 'CLEAN', score: 25, evidenceIds: ['ev1'] },
    {
      validationStatus: 'VALID',
      opinion: 'SUSPICIOUS',
      confidence: 0.8,
      citedEvidenceIds: ['ev1'],
    },
  );
  expect(risk.origin).toBe('AI_ESCALATION');
  expect(risk.policyVersion).toBe('2');
  expect(JSON.parse(risk.traceJson)).toEqual(expected.trace);
  const analysis = new AIAnalysisRepository(harness.db).latestValidByResult(
    result.id,
  )!;
  expect(analysis.model).toBe('fake-evidence-v1');
  expect(
    harness.db
      .prepare(
        "SELECT validation_status FROM ai_analyses WHERE job_id = ? AND kind = 'JOB_SUMMARY'",
      )
      .get(job.id)?.validation_status,
  ).toBe('VALID');
}, 25_000);

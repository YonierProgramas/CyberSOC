import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { RiskAssessmentRepository } from '../src/core/persistence/RiskAssessmentRepository';
import { EvidenceRepository } from '../src/core/persistence/EvidenceRepository';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import type { AIAssessment } from '../src/core/ai/schemas';
vi.mock('electron', () => ({ app: {}, safeStorage: {} }));
import { AIFlowHarness } from './fixtures/AIFlowHarness';

function answer(
  opinion: AIAssessment['opinion'] = 'LIKELY_BENIGN',
  ids = ['ev1'],
): AIAssessment {
  return {
    schema: 'cybersoc.ai-assessment/v1',
    summary: 'Revisión del resultado local.',
    plainExplanation: 'La muestra requiere verificar su origen.',
    technicalAnalysis: 'Se consideran los indicios citados.',
    correlations: [],
    opinion,
    confidence: 0.8,
    recommendedAction: 'VERIFY_SOURCE',
    actionRationale: 'Verifica el origen antes de usar el archivo.',
    falsePositiveNotes: '',
    citedEvidenceIds: ids,
  };
}
let harness: AIFlowHarness;
let fake: FakeAIProvider;
beforeEach(async () => {
  fake = new FakeAIProvider();
  harness = new AIFlowHarness(() => fake);
  await harness.prepare();
}, 20_000);
afterEach(async () => {
  vi.useRealTimers();
  await harness.close();
});
function result(id: string) {
  return new ScanResultRepository(harness.db).get(id)!;
}
function attempts(id: string) {
  return harness.db
    .prepare(
      'SELECT validation_status, context_json FROM ai_analyses WHERE result_id = ? ORDER BY rowid',
    )
    .all(id);
}

it('CA-2.3: un escaneo real de siete fixtures analiza los seis no limpios y omite el limpio', async () => {
  for (let i = 0; i < 6; i++) fake.enqueueValue(answer());
  harness.worker.start();
  const { job, results } = await harness.scan();
  expect(job.status).toBe('COMPLETED');
  expect(results).toHaveLength(7);
  const risky = results.filter((row) => row.verdict !== 'CLEAN');
  expect(risky.filter((row) => row.verdict === 'DETECTED')).toHaveLength(5);
  expect(risky.filter((row) => row.verdict === 'SUSPICIOUS')).toHaveLength(1);
  await vi.waitFor(() =>
    expect(risky.every((row) => result(row.id).aiStatus === 'COMPLETED')).toBe(
      true,
    ),
  );
  expect(fake.requests).toHaveLength(6);
  const clean = results.find((row) => row.verdict === 'CLEAN')!;
  expect(result(clean.id).aiStatus).toBe('NOT_REQUIRED');
  expect(attempts(clean.id)).toHaveLength(0);
  for (const row of risky) {
    const saved = new AIAnalysisRepository(harness.db).latestValidByResult(
      row.id,
    )!;
    expect(saved.validationStatus).toBe('VALID');
    const response = JSON.parse(saved.responseJson!) as AIAssessment;
    const existing = new EvidenceRepository(harness.db)
      .listByResult(row.id)
      .map((e) => e.evidenceKey);
    expect(response.citedEvidenceIds.every((id) => existing.includes(id))).toBe(
      true,
    );
    expect(saved.contextJson).not.toContain('texto inofensivo de prueba.');
  }
}, 20_000);

it('CA-2.5: OFFLINE no bloquea el escaneo; tres reintentos, pausa y recuperación explícita', async () => {
  for (let i = 0; i < 4; i++) fake.enqueueError('OFFLINE');
  fake.enqueueValue(answer());
  const { job, results } = await harness.scan(harness.signature);
  const id = results[0]!.id;
  expect(job.status).toBe('COMPLETED');
  expect(result(id).aiStatus).toBe('PENDING');
  vi.useFakeTimers();
  harness.worker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(result(id).aiStatus).toBe('RETRY_WAIT');
  await vi.advanceTimersByTimeAsync(7000);
  expect(fake.requests).toHaveLength(4);
  expect(result(id)).toMatchObject({
    verdict: 'DETECTED',
    aiStatus: 'UNAVAILABLE',
  });
  expect(harness.worker.state.paused).toBe(true);
  const policy = new RiskAssessmentRepository(harness.db).get(id)!;
  expect(policy.traceJson).toContain('IA pendiente / no disponible');
  harness.worker.resume(); // Señal de recuperación: la integración usa healthCheck exitoso.
  await vi.advanceTimersByTimeAsync(0);
  expect(result(id)).toMatchObject({
    verdict: 'DETECTED',
    aiStatus: 'COMPLETED',
  });
  expect(attempts(id).map((row) => row.validation_status)).toEqual([
    'PROVIDER_ERROR',
    'PROVIDER_ERROR',
    'PROVIDER_ERROR',
    'PROVIDER_ERROR',
    'VALID',
  ]);
});

it('CA-2.5: un RETRY_WAIT por OFFLINE se recupera al reabrir SQLite y reiniciar el worker', async () => {
  fake.enqueueError('OFFLINE').enqueueValue(answer());
  const { results } = await harness.scan(harness.signature);
  const id = results[0]!.id;
  harness.worker.start();
  await vi.waitFor(() => expect(result(id).aiStatus).toBe('RETRY_WAIT'));
  await harness.restart();
  await vi.waitFor(() => expect(result(id).aiStatus).toBe('COMPLETED'));
  expect(fake.requests).toHaveLength(2);
  expect(attempts(id).map((row) => row.validation_status)).toEqual([
    'PROVIDER_ERROR',
    'VALID',
  ]);
});

it('CA-2.6: un ID inventado se rechaza dos veces y nunca afecta el veredicto', async () => {
  fake
    .enqueueValue(answer('LIKELY_BENIGN', ['ev999']))
    .enqueueValue(answer('LIKELY_BENIGN', ['ev999']));
  const { results } = await harness.scan(harness.signature);
  const id = results[0]!.id;
  harness.worker.start();
  await vi.waitFor(() => expect(result(id).aiStatus).toBe('INVALID'));
  expect(attempts(id).map((row) => row.validation_status)).toEqual([
    'UNKNOWN_EVIDENCE',
    'UNKNOWN_EVIDENCE',
  ]);
  expect(
    new AIAnalysisRepository(harness.db).latestValidByResult(id),
  ).toBeUndefined();
  expect(new RiskAssessmentRepository(harness.db).get(id)).toMatchObject({
    engineVerdict: 'DETECTED',
    finalVerdict: 'DETECTED',
    aiOpinion: null,
    reviewRequired: false,
  });
  expect(fake.requests[1]!.prompt).toContain('ev999');
});

it.each([
  ['lowScore', 'CLEAN', 'LIKELY_MALICIOUS'],
  ['suspicious', 'SUSPICIOUS', 'LIKELY_BENIGN'],
  ['signature', 'DETECTED', 'LIKELY_BENIGN'],
] as const)(
  'CA-2.8: %s mantiene %s aunque la IA opine %s',
  async (file, verdict, opinion) => {
    const { results } = await harness.scan(harness[file]);
    const before = results[0]!;
    expect(before.verdict).toBe(verdict);
    fake.enqueueValue(answer(opinion));
    harness.worker.start();
    await vi.waitFor(() =>
      expect(result(before.id).aiStatus).toBe('COMPLETED'),
    );
    expect(result(before.id)).toMatchObject({
      verdict,
      engineScore: before.engineScore,
      riskLevel: before.riskLevel,
    });
    expect(
      new RiskAssessmentRepository(harness.db).get(before.id),
    ).toMatchObject({
      engineVerdict: verdict,
      finalVerdict: verdict,
      aiOpinion: opinion,
      reviewRequired: true,
      origin: 'ENGINE',
    });
  },
);

it('CA-2.8: una acusación sin evidencias sobre CLEAN se descarta y no lo escala', async () => {
  const { results } = await harness.scan(harness.clean);
  const id = results[0]!.id;
  fake
    .enqueueValue(answer('LIKELY_MALICIOUS', []))
    .enqueueValue(answer('LIKELY_MALICIOUS', []));
  harness.worker.analyzeNow(id);
  harness.worker.start();
  await vi.waitFor(() => expect(result(id).aiStatus).toBe('INVALID'));
  expect(result(id).verdict).toBe('CLEAN');
  expect(new RiskAssessmentRepository(harness.db).get(id)).toMatchObject({
    aiOpinion: null,
    reviewRequired: false,
  });
});

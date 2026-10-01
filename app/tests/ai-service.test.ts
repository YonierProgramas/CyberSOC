import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { RiskAssessmentRepository } from '../src/core/persistence/RiskAssessmentRepository';
import { AIAnalysisRepository } from '../src/core/persistence/AIAnalysisRepository';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { AIContextBuilder } from '../src/core/ai/AIContextBuilder';
import { AIAnalysisStore } from '../src/core/ai/AIAnalysisStore';
import { AISecurityService } from '../src/core/ai/AISecurityService';
import { AIAnalysisWorker } from '../src/core/ai/AIAnalysisWorker';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import { decideRisk } from '../src/core/risk/RiskPolicy';
import type { Evidence } from '../src/shared/protocol';
import type { AIAssessment } from '../src/core/ai/schemas';
import type { AIResult } from '../src/core/ai/AIProvider';

const valid: AIAssessment = {
  schema: 'cybersoc.ai-assessment/v1',
  summary: 'Se revisó ev1 de FILETYPE.',
  plainExplanation: 'Hay señales que revisar.',
  technicalAnalysis: 'ev1 describe una discrepancia de tipo.',
  correlations: [],
  opinion: 'LIKELY_BENIGN',
  confidence: 0.8,
  recommendedAction: 'VERIFY_SOURCE',
  actionRationale: 'Confirma el origen del archivo.',
  falsePositiveNotes: '',
  citedEvidenceIds: ['ev1'],
};
const evidence: Evidence = {
  id: 'ev1',
  source: 'FILETYPE',
  code: 'TYPE_MISMATCH',
  title: 'Tipo inesperado',
  severity: 'HIGH',
  points: 25,
  decisive: false,
  confidence: 0.9,
  facts: { content: 'NEVER_SEND_THIS_CONTENT' },
};
const config = appConfigSchema.parse({});
let directory: string;
let db: Database;
let store: AIAnalysisStore;
let fake: FakeAIProvider;
let service: AISecurityService;
let worker: AIAnalysisWorker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
  directory = mkdtempSync(join(tmpdir(), 'cybersoc-ai-service-'));
  db = new Database(join(directory, 'ai.db'));
  new MigrationRunner(db).run();
  new ScanJobRepository(db).create({
    id: 'job',
    targetPath: 'C:\\Users\\ana',
    targetKind: 'FOLDER',
    engineVersion: '0.0.1',
  });
  new ScanJobRepository(db).create({
    id: 'other',
    targetPath: 'C:\\Users\\ana',
    targetKind: 'FOLDER',
  });
  store = new AIAnalysisStore(db);
  fake = new FakeAIProvider();
  service = new AISecurityService(
    store,
    () => fake,
    () => config,
  );
  worker = new AIAnalysisWorker(service);
});
afterEach(async () => {
  await worker.stop();
  vi.useRealTimers();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function seed(
  seq = 0,
  options: {
    jobId?: string;
    clean?: boolean;
    evidence?: Evidence[];
    verdict?: 'CLEAN' | 'SUSPICIOUS' | 'DETECTED';
    score?: number;
  } = {},
) {
  const jobId = options.jobId ?? 'job';
  const id = `${jobId}-${seq}`;
  const decision = decideRisk({
    verdict: options.verdict ?? (options.clean ? 'CLEAN' : 'SUSPICIOUS'),
    score: options.score ?? (options.clean ? 0 : 40),
  });
  new ScanResultRepository(db).insertComplete({
    result: {
      id,
      jobId,
      seq,
      path: 'C:\\Users\\ana\\Downloads\\factura.pdf',
      fileName: 'factura.pdf',
      status: 'SCANNED',
      sha256: 'a'.repeat(64),
    },
    evidence: options.evidence ?? (options.clean ? [] : [evidence]),
    layers: [
      {
        layer: 'FILETYPE',
        status: 'RAN',
        hits: options.clean ? 0 : 1,
        points: options.clean ? 0 : 25,
        ms: 1,
      },
    ],
    assessment: {
      engineVerdict: decision.engineVerdict,
      engineScore: decision.engineScore,
      finalVerdict: decision.finalVerdict,
      finalLevel: decision.finalLevel,
      origin: decision.origin,
      reviewRequired: false,
      traceJson: JSON.stringify(decision.trace),
      policyVersion: decision.policyVersion,
    },
  });
  return id;
}
function rows() {
  return db.prepare('SELECT * FROM ai_analyses ORDER BY rowid').all();
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

it('contexto v1: top 20 estable, capas, desglose, historial y ningún contenido', () => {
  seed();
  const id = seed(1, {
    evidence: Array.from({ length: 25 }, (_, i) => ({
      ...evidence,
      id: `ev${i + 1}`,
      points: i,
    })),
  });
  const input = store.load(id);
  const built = new AIContextBuilder(() => config).build(
    input.result,
    input.analysis,
  );
  expect(built.context.evidence).toHaveLength(20);
  expect(built.context.evidence[0]!.id).toBe('ev25');
  expect(built.context.evidence[19]!.id).toBe('ev6');
  expect(built.context.engine.scoreBreakdown[0]).toEqual({
    evidenceId: 'ev25',
    points: 24,
  });
  expect(built.context.layers).toEqual([
    { layer: 'FILETYPE', status: 'RAN', hits: 1 },
  ]);
  expect(built.context.history?.timesSeenBefore).toBe(1);
  expect(built.context.constraints.evidenceTruncated).toBe(true);
  expect(built.json).not.toContain('NEVER_SEND_THIS_CONTENT');
  expect(built.json).not.toContain('ana');
  expect(built.sha256).toBe(
    createHash('sha256').update(built.json).digest('hex'),
  );
});

it('guarda respuesta, contexto exacto, tokens y decisión sin bajar el veredicto', async () => {
  const id = seed();
  fake.enqueueValue(valid, {
    model: 'fake-version',
    usage: { inputTokens: 11, outputTokens: 22 },
    latencyMs: 35,
  });
  expect(await service.analyze(id)).toEqual({ status: 'COMPLETED' });
  const saved = new AIAnalysisRepository(db).latestValidByResult(id)!;
  expect(saved).toMatchObject({
    model: 'fake-version',
    inputTokens: 11,
    outputTokens: 22,
    latencyMs: 35,
    validationStatus: 'VALID',
    promptVersion: 'analysis.v1',
  });
  expect(fake.requests[0]!.prompt).toContain(saved.contextJson);
  expect(saved.contextSha256).toBe(
    createHash('sha256').update(saved.contextJson).digest('hex'),
  );
  expect(new RiskAssessmentRepository(db).get(id)).toMatchObject({
    finalVerdict: 'SUSPICIOUS',
    reviewRequired: true,
    policyVersion: '1',
  });
  expect(store.results.get(id)?.aiStatus).toBe('COMPLETED');
});

it('reintenta validación una vez con retroalimentación; registra ambos intentos', async () => {
  const id = seed();
  fake
    .enqueueRaw('{broken', {
      model: 'actual-model',
      latencyMs: 123,
      usage: { inputTokens: 42, outputTokens: 7 },
    })
    .enqueueValue(valid);
  await service.analyze(id);
  expect(rows().map((r) => r.validation_status)).toEqual([
    'INVALID_JSON',
    'VALID',
  ]);
  expect(fake.requests[1]!.prompt).toContain('La respuesta no es JSON válido.');
  expect(fake.requests[1]!.prompt).not.toContain('{broken');
  expect(rows()[0]!.context_json).toBe(rows()[1]!.context_json);
  expect(rows()[0]).toMatchObject({
    model: 'actual-model',
    latency_ms: 123,
    input_tokens: 42,
    output_tokens: 7,
  });
});

it('al cerrar cancela la petición y deja PENDING sin registrar un fallo falso', async () => {
  const id = seed();
  const request = vi.spyOn(fake, 'generateStructured').mockImplementation(
    async (req) =>
      new Promise<AIResult<never>>((resolve) => {
        req.signal!.addEventListener(
          'abort',
          () =>
            resolve({
              ok: false,
              error: {
                kind: 'TIMEOUT',
                retryable: false,
                message: 'cancelado',
              },
            }),
          { once: true },
        );
      }),
  );
  worker.analyzeNow(id);
  worker.start();
  await flush();
  expect(store.results.get(id)?.aiStatus).toBe('RUNNING');
  await worker.stop();
  expect(request).toHaveBeenCalledOnce();
  expect(store.results.get(id)?.aiStatus).toBe('PENDING');
  expect(rows()).toHaveLength(0);
  request.mockRestore();
  fake.enqueueValue(valid);
  worker.start();
  await flush();
  expect(store.results.get(id)?.aiStatus).toBe('COMPLETED');
});

it('un suscriptor que lanza no interrumpe el análisis ni los otros suscriptores', async () => {
  const id = seed();
  fake.enqueueValue(valid);
  worker.on('ai:resultUpdated', () => {
    throw new Error('ventana cerrada');
  });
  const listener = vi.fn();
  worker.on('ai:resultUpdated', listener);
  worker.analyzeNow(id);
  worker.start();
  await flush();
  expect(store.results.get(id)?.aiStatus).toBe('COMPLETED');
  expect(listener).toHaveBeenCalledWith({
    resultId: id,
    aiStatus: 'COMPLETED',
  });
  expect(worker.state.paused).toBe(false);
});

it('no cita evidencias fuera del top 20 y conserva empates en orden del motor', async () => {
  const id = seed(0, {
    evidence: Array.from({ length: 21 }, (_, i) => ({
      ...evidence,
      id: `ev${i + 1}`,
      title: 'C:\\Users\\ana\\secreto.pdf',
    })),
  });
  service = new AISecurityService(
    store,
    () => fake,
    () => ({
      ...config,
      ai: { ...config.ai, sendFileNames: false },
    }),
  );
  fake
    .enqueueValue({ ...valid, citedEvidenceIds: ['ev21'] })
    .enqueueValue(valid);
  await service.analyze(id);
  expect(rows()[0]!.validation_status).toBe('UNKNOWN_EVIDENCE');
  const context = JSON.parse(String(rows()[0]!.context_json));
  expect(context.evidence.map((e: { id: string }) => e.id)).toEqual(
    Array.from({ length: 20 }, (_, i) => `ev${i + 1}`),
  );
  expect(rows()[0]!.context_json).not.toContain('secreto.pdf');
  expect(rows()[0]!.context_json).not.toContain('factura.pdf');
});

it('segundo fallo queda INVALID y una salida insegura se descarta sin reintento', async () => {
  const id = seed();
  fake.enqueueRaw('{}').enqueueRaw('{}');
  expect(await service.analyze(id)).toEqual({ status: 'INVALID' });
  expect(fake.requests).toHaveLength(2);
  const other = seed(1);
  fake.enqueueValue({ ...valid, summary: 'Abre https://example.com' });
  expect(await service.analyze(other)).toEqual({ status: 'INVALID' });
  expect(fake.requests).toHaveLength(3);
  expect(rows()[2]!.validation_status).toBe('UNSAFE');
});

it('INCOMPLETE permite solo un reintento con más tokens', async () => {
  const id = seed();
  fake.enqueueRaw('{cut', { stopReason: 'max_tokens' }).enqueueValue(valid);
  await service.analyze(id);
  expect(fake.requests.map((r) => r.maxTokens)).toEqual([1200, 2400]);
  expect(rows()[0]!.validation_status).toBe('INCOMPLETE');
});

it('rollback del intento y estado si falla el guardado de la evaluación', async () => {
  const id = seed();
  fake.enqueueValue(valid);
  db.exec(
    "CREATE TRIGGER fail_risk BEFORE UPDATE ON risk_assessments BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  await expect(service.analyze(id)).rejects.toThrow('test failure');
  expect(rows()).toHaveLength(0);
  expect(store.results.get(id)?.aiStatus).toBe('RUNNING');
  expect(new RiskAssessmentRepository(db).get(id)?.aiOpinion).toBeNull();
});

it('sin duplicados, evento y disparo manual de un CLEAN sin evidencia', async () => {
  const first = seed();
  const second = seed(1, { clean: true });
  fake.enqueueValue(valid).enqueueValue({
    ...valid,
    opinion: 'INSUFFICIENT_EVIDENCE',
    citedEvidenceIds: [],
    summary: 'Sin evidencia',
    technicalAnalysis: 'No hay indicios.',
  });
  const events: string[] = [];
  worker.on('ai:resultUpdated', (e) =>
    events.push(`${e.resultId}:${e.aiStatus}`),
  );
  expect(worker.enqueueAutomatic(first)).toBe(true);
  expect(worker.enqueueAutomatic(first)).toBe(false);
  expect(worker.enqueueAutomatic(second)).toBe(false);
  worker.analyzeNow(first);
  worker.analyzeNow(second);
  worker.start();
  await flush();
  expect(rows().map((r) => r.result_id)).toEqual([first, second]);
  expect(worker.state.pending).toBe(0);
  expect(events).toContain(`${second}:COMPLETED`);
});

it('429 respeta retryAfterMs y no adelanta el segundo archivo', async () => {
  const first = seed();
  const second = seed(1);
  fake
    .enqueueError('RATE_LIMIT', { retryAfterMs: 5000 })
    .enqueueValue(valid)
    .enqueueValue(valid);
  worker.analyzeNow(first);
  worker.analyzeNow(second);
  worker.start();
  await flush();
  expect(store.results.get(first)?.aiStatus).toBe('RETRY_WAIT');
  await vi.advanceTimersByTimeAsync(4999);
  worker.resume(); // Un healthCheck exitoso no debe saltarse Retry-After.
  expect(fake.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.requests).toHaveLength(3);
  expect(rows().map((r) => r.result_id)).toEqual([first, first, second]);
});

it('401 pausa NOT_CONFIGURED sin reintentos hasta resume', async () => {
  const first = seed();
  const second = seed(1);
  fake.enqueueError('AUTH').enqueueValue(valid).enqueueValue(valid);
  worker.analyzeNow(first);
  worker.analyzeNow(second);
  worker.start();
  await flush();
  expect(worker.state.paused).toBe(true);
  expect(store.results.get(first)?.aiStatus).toBe('NOT_CONFIGURED');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fake.requests).toHaveLength(1);
  worker.resume();
  await flush();
  expect(fake.requests).toHaveLength(3);
});

it('timeout usa backoff y tres fallos consecutivos abren el circuito 60 segundos', async () => {
  const id = seed();
  fake
    .enqueueError('TIMEOUT')
    .enqueueError('PROVIDER_DOWN')
    .enqueueError('PROVIDER_DOWN')
    .enqueueValue(valid);
  worker.analyzeNow(id);
  worker.start();
  await flush();
  await vi.advanceTimersByTimeAsync(999);
  expect(fake.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.requests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fake.requests).toHaveLength(3);
  expect(worker.state.openUntil).toBe(Date.now() + 60_000);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(fake.requests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.requests).toHaveLength(4);
  expect(store.results.get(id)?.aiStatus).toBe('COMPLETED');
});

it('sin red: tres reintentos, UNAVAILABLE y pausa; resume conserva el pendiente', async () => {
  const id = seed();
  for (let i = 0; i < 4; i++) fake.enqueueError('OFFLINE');
  fake.enqueueValue(valid);
  worker.analyzeNow(id);
  worker.start();
  await flush();
  await vi.advanceTimersByTimeAsync(7000);
  expect(fake.requests).toHaveLength(4);
  expect(worker.state.paused).toBe(true);
  expect(store.results.get(id)?.aiStatus).toBe('UNAVAILABLE');
  worker.resume();
  await flush();
  expect(store.results.get(id)?.aiStatus).toBe('COMPLETED');
});

it('reiniciar recupera PENDING, RETRY_WAIT y un RUNNING interrumpido', async () => {
  for (const [i, state] of (
    ['PENDING', 'RETRY_WAIT', 'RUNNING'] as const
  ).entries()) {
    const id = seed(i);
    store.setStatus(id, state);
    fake.enqueueValue(valid);
  }
  await worker.stop();
  db.close();
  db = new Database(join(directory, 'ai.db'));
  store = new AIAnalysisStore(db);
  service = new AISecurityService(
    store,
    () => fake,
    () => config,
  );
  worker = new AIAnalysisWorker(service);
  worker.start();
  await flush();
  expect(rows().map((r) => r.result_id)).toEqual(['job-0', 'job-1', 'job-2']);
});

it('tope persistido de 50 automáticos por trabajo; manual no consume ese tope', async () => {
  for (let i = 0; i < 51; i++) {
    const id = seed(i);
    expect(worker.enqueueAutomatic(id)).toBe(i < 50);
  }
  expect(worker.enqueueAutomatic(seed(0, { jobId: 'other' }))).toBe(true);
  await worker.stop();
  worker = new AIAnalysisWorker(service);
  expect(worker.enqueueAutomatic('job-50')).toBe(false);
  worker.analyzeNow('job-50');
  expect(store.results.get('job-50')?.aiStatus).toBe('PENDING');
  expect(worker.state.pending).toBe(1);
});

it('automatico incluye CLEAN con evidencia MEDIUM, y configuración puede reducir el tope', () => {
  worker = new AIAnalysisWorker(service, () => 1);
  const id = seed(0, {
    clean: true,
    evidence: [{ ...evidence, severity: 'MEDIUM', points: 15 }],
  });
  expect(worker.enqueueAutomatic(id)).toBe(true);
  expect(worker.enqueueAutomatic(seed(1))).toBe(false);
});

it('proveedor no configurado se registra sin red y sin alterar el veredicto', async () => {
  const id = seed();
  service = new AISecurityService(
    store,
    () => null,
    () => config,
  );
  expect(await service.analyze(id)).toMatchObject({
    status: 'PROVIDER_ERROR',
    error: { kind: 'AUTH' },
  });
  expect(rows()[0]!.validation_status).toBe('PROVIDER_ERROR');
  expect(store.results.get(id)).toMatchObject({
    verdict: 'SUSPICIOUS',
    aiStatus: 'NOT_CONFIGURED',
  });
});

it('corregir la credencial recupera NOT_CONFIGURED incluso después de reiniciar', async () => {
  const id = seed();
  store.setStatus(id, 'NOT_CONFIGURED');
  worker.start();
  await flush();
  expect(fake.requests).toHaveLength(0);
  fake.enqueueValue(valid);
  worker.resume();
  await flush();
  expect(store.results.get(id)?.aiStatus).toBe('COMPLETED');
});

it.each(['manual', 'reinicio'] as const)(
  'prioridad: tres pendientes, primero el mayor riesgo (%s)',
  async (mode) => {
    const low = seed(0, { score: 40 });
    const high = seed(1, { score: 90 });
    const detected = seed(2, { verdict: 'DETECTED', score: 85 });
    fake.enqueueValue(valid).enqueueValue(valid).enqueueValue(valid);
    if (mode === 'manual') {
      for (const id of [low, high, detected]) worker.analyzeNow(id);
    } else {
      store.setStatus(low, 'PENDING');
      store.setStatus(high, 'RETRY_WAIT');
      store.setStatus(detected, 'PENDING');
      await worker.stop();
      worker = new AIAnalysisWorker(service);
    }
    worker.start();
    await flush();
    const order = rows().map((row) => row.result_id);
    expect(order).toEqual([detected, high, low]);
    expect(fake.requests).toHaveLength(3);
    expect(worker.state.pending).toBe(0);
    console.log(
      'AI_PRIORITY_ORDER',
      JSON.stringify({ mode, priorities: [185, 90, 40], resultIds: order }),
    );
  },
);

it('empates usan llegada al worker, no el seq del resultado en SQLite', async () => {
  const first = seed(2);
  const second = seed(0);
  const third = seed(1);
  fake.enqueueValue(valid).enqueueValue(valid).enqueueValue(valid);
  for (const id of [first, second, third]) worker.analyzeNow(id);
  worker.start();
  await flush();
  expect(rows().map((row) => row.result_id)).toEqual([first, second, third]);
});

it('una llegada prioritaria durante RUNNING no duplica ni retira el análisis equivocado', async () => {
  const current = seed(0);
  const low = seed(1);
  const high = seed(2, { verdict: 'DETECTED', score: 85 });
  fake.enqueueValue(valid).enqueueValue(valid).enqueueValue(valid);
  worker.analyzeNow(current);
  let observedPending = 0;
  worker.once('ai:resultUpdated', () => {
    worker.analyzeNow(low);
    worker.analyzeNow(high);
    worker.analyzeNow(current); // Sigue deduplicado mientras está en vuelo.
    observedPending = worker.state.pending;
  });
  worker.start();
  await flush();
  expect(observedPending).toBe(3);
  expect(rows().map((row) => row.result_id)).toEqual([current, high, low]);
  expect(fake.requests).toHaveLength(3);
  expect(worker.state.pending).toBe(0);
});

it('una prioridad nueva no evita Retry-After y se atiende después del reintento', async () => {
  const current = seed(0);
  const low = seed(1);
  const high = seed(2, { verdict: 'DETECTED', score: 85 });
  fake.enqueueError('RATE_LIMIT', { retryAfterMs: 5000 });
  fake.enqueueValue(valid).enqueueValue(valid).enqueueValue(valid);
  worker.analyzeNow(current);
  worker.start();
  await flush();
  worker.analyzeNow(low);
  worker.analyzeNow(high);
  await vi.advanceTimersByTimeAsync(4999);
  expect(fake.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(rows().map((row) => row.result_id)).toEqual([
    current,
    current,
    high,
    low,
  ]);
  expect(worker.state.pending).toBe(0);
});

it('parar en vuelo conserva el trabajo aunque llegue uno más prioritario', async () => {
  const current = seed(0);
  const high = seed(1, { verdict: 'DETECTED', score: 85 });
  const original = fake.generateStructured.bind(fake);
  const request = vi
    .spyOn(fake, 'generateStructured')
    .mockImplementationOnce(
      (req) =>
        new Promise<AIResult<never>>((resolve) => {
          req.signal!.addEventListener('abort', () =>
            resolve({
              ok: false,
              error: { kind: 'TIMEOUT', retryable: true, message: 'cancelado' },
            }),
          );
        }),
    )
    .mockImplementation(original);
  worker.analyzeNow(current);
  worker.start();
  await flush();
  worker.analyzeNow(high);
  await worker.stop();
  expect(store.results.get(current)?.aiStatus).toBe('PENDING');
  expect(worker.state.pending).toBe(2);
  request.mockRestore();
  fake.enqueueValue(valid).enqueueValue(valid);
  worker.start();
  await flush();
  expect(rows().map((row) => row.result_id)).toEqual([current, high]);
  expect(worker.state.pending).toBe(0);
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { EvidenceRepository } from '../src/core/persistence/EvidenceRepository';
import { LayerTraceRepository } from '../src/core/persistence/LayerTraceRepository';
import { RiskAssessmentRepository } from '../src/core/persistence/RiskAssessmentRepository';
import type { ScanJobRecord } from '../src/core/persistence/ScanJobRepository';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import { aiAssessmentSchema } from '../src/core/ai/schemas';
import type { AIAnalysisWorker } from '../src/core/ai/AIAnalysisWorker';
import type { EngineResult } from '../src/shared/protocol';
import { FakeEngineClient, scanned } from './FakeEngineClient';
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {},
}));
import {
  createAIWorkflow,
  createScanOrchestrator,
} from '../src/main/composition-root';

let directory: string;
let db: Database;
let fake: FakeAIProvider;
/** Peticiones de análisis por archivo; cada escaneo completado añade además su JOB_SUMMARY. */
function fileRequests() {
  return fake.requests.filter(
    (request) => request.schema === aiAssessmentSchema,
  );
}
let worker: AIAnalysisWorker;
let engine: FakeEngineClient;
const evidence: EngineResult['evidence'] = [
  {
    id: 'ev1',
    source: 'FILETYPE',
    code: 'TYPE_MISMATCH',
    title: 'Tipo incompatible',
    severity: 'HIGH',
    points: 25,
    decisive: false,
    confidence: 0.9,
    facts: { detectedType: 'PE', content: 'NO_ENVIAR' },
  },
];
const layers: EngineResult['layers'] = [
  { layer: 'HASH', status: 'RAN', hits: 0, points: 0, ms: 1 },
  { layer: 'FILETYPE', status: 'RAN', hits: 1, points: 25, ms: 1 },
];
const assessed: Partial<EngineResult> = {
  evidence,
  layers,
  verdict: 'SUSPICIOUS',
  score: 40,
  riskLevel: 'MEDIO',
};
const valid = {
  schema: 'cybersoc.ai-assessment/v1',
  summary: 'Revisar ev1.',
  plainExplanation: 'Hay una discrepancia.',
  technicalAnalysis: 'ev1 de FILETYPE requiere revisión.',
  correlations: [],
  opinion: 'LIKELY_BENIGN',
  confidence: 0.8,
  recommendedAction: 'VERIFY_SOURCE',
  actionRationale: 'Verifica el origen.',
  falsePositiveNotes: '',
  citedEvidenceIds: ['ev1'],
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cybersoc-ai-flow-'));
  db = new Database(join(directory, 'test.db'));
  new MigrationRunner(db).run();
  fake = new FakeAIProvider();
  worker = createAIWorkflow(db, () => fake);
  engine = new FakeEngineClient();
  worker.start();
});
afterEach(async () => {
  await worker.stop();
  db.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function scan(
  reply: Partial<EngineResult> = assessed,
  sink: Pick<AIAnalysisWorker, 'enqueueAutomatic'> = worker,
) {
  const path = join(directory, 'fixture.txt');
  writeFileSync(path, 'Texto inofensivo de prueba.');
  engine.responses.push(async (params) => ({ ...scanned(params), ...reply }));
  const orchestrator = createScanOrchestrator(db, engine, sink);
  const done = new Promise<ScanJobRecord>((resolve) =>
    orchestrator.once('finished', resolve),
  );
  const jobId = orchestrator.start({ kind: 'FILE', path });
  const job = await done;
  return {
    job,
    result: new ScanResultRepository(db).listByJob(jobId, 0, 1)[0],
  };
}

it('escaneo → transacción completa → IA → RiskPolicy, usando las fábricas reales de main', async () => {
  fake.enqueueValue(valid);
  const event = vi.fn();
  worker.on('ai:resultUpdated', event);
  const { job, result } = await scan();
  expect(job.status).toBe('COMPLETED');
  await vi.waitFor(() =>
    expect(new ScanResultRepository(db).get(result!.id)?.aiStatus).toBe(
      'COMPLETED',
    ),
  );
  expect(result).toMatchObject({
    verdict: 'SUSPICIOUS',
    engineScore: 40,
    riskLevel: 'MEDIO',
    detectedType: 'PE',
  });
  expect(new EvidenceRepository(db).listByResult(result!.id)).toHaveLength(1);
  expect(new LayerTraceRepository(db).listByResult(result!.id)).toHaveLength(2);
  expect(new RiskAssessmentRepository(db).get(result!.id)).toMatchObject({
    finalVerdict: 'SUSPICIOUS',
    reviewRequired: true,
  });
  expect(fileRequests()).toHaveLength(1);
  expect(fileRequests()[0]!.prompt).toContain('TYPE_MISMATCH');
  expect(fileRequests()[0]!.prompt).not.toContain('NO_ENVIAR');
  expect(event).toHaveBeenCalledWith({
    resultId: result!.id,
    aiStatus: 'COMPLETED',
  });
});

it('un CLEAN sin evidencia conserva evaluación local y no llama a la IA', async () => {
  const { result } = await scan({
    verdict: 'CLEAN',
    score: 0,
    riskLevel: 'BAJO',
  });
  expect(result).toMatchObject({
    verdict: 'CLEAN',
    engineScore: 0,
    aiStatus: 'NOT_REQUIRED',
  });
  expect(fileRequests()).toHaveLength(0);
});

it('un fallo de API no impide terminar el escaneo local', async () => {
  fake.enqueueError('RATE_LIMIT', { retryAfterMs: 60_000 });
  const { job, result } = await scan();
  expect(job.status).toBe('COMPLETED');
  expect(new ScanResultRepository(db).get(result!.id)).toMatchObject({
    verdict: 'SUSPICIOUS',
    aiStatus: 'RETRY_WAIT',
  });
});

it('un fallo al insertar capas revierte todas las tablas y no encola IA', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.exec(
    "CREATE TRIGGER fail_layers BEFORE INSERT ON result_layers BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END;",
  );
  const { job, result } = await scan();
  expect(job.status).toBe('FAILED');
  expect(result).toBeUndefined();
  for (const table of ['evidences', 'result_layers', 'risk_assessments']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
  }
  expect(fileRequests()).toHaveLength(0);
});

it('un fallo de la cola conserva el resultado y se comunica sin detalles sensibles', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { job, result } = await scan(assessed, {
    enqueueAutomatic: () => {
      throw new Error('secreto-ficticio');
    },
  });
  expect(job.status).toBe('COMPLETED');
  expect(result?.verdict).toBe('SUSPICIOUS');
  expect(log).toHaveBeenCalledWith('No se pudo encolar el análisis de IA.');
  expect(JSON.stringify(log.mock.calls)).not.toContain('secreto-ficticio');
});

it('respuestas antiguas conservan hechos sin inventar puntuación ni enviarse automáticamente', async () => {
  const { result } = await scan({ evidence, layers });
  expect(result).toMatchObject({ verdict: 'NOT_EVALUATED', engineScore: null });
  expect(new EvidenceRepository(db).listByResult(result!.id)).toHaveLength(1);
  expect(new LayerTraceRepository(db).listByResult(result!.id)).toHaveLength(2);
  expect(fileRequests()).toHaveLength(0);
});

it('un archivo no analizado conserva traza y puntuación nula sin evaluación inventada', async () => {
  const sink = { enqueueAutomatic: vi.fn(() => true) };
  const { result } = await scan(
    {
      status: 'SKIPPED',
      verdict: 'NOT_ANALYZED',
      score: null,
      riskLevel: null,
      layers: [
        {
          layer: 'HASH',
          status: 'SKIPPED',
          reason: 'TOO_LARGE',
          hits: 0,
          points: 0,
          ms: 0,
        },
      ],
    },
    sink,
  );
  expect(result).toMatchObject({
    verdict: 'NOT_ANALYZED',
    engineScore: null,
    riskLevel: null,
  });
  expect(new RiskAssessmentRepository(db).get(result!.id)).toBeUndefined();
  expect(new LayerTraceRepository(db).listByResult(result!.id)[0]?.reason).toBe(
    'TOO_LARGE',
  );
});

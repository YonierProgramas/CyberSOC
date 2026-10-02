import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { RpcRemoteError } from '../src/core/engine/EngineClient';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import {
  ScanJobRepository,
  type ScanJobRecord,
} from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { FileDiscovery } from '../src/core/scan/FileDiscovery';
import {
  fileTimeoutMs,
  ScanOrchestrator,
  type ScanDependencies,
  type ScanDiscovery,
  type ScanProgress,
} from '../src/core/scan/ScanOrchestrator';
import type { EngineResult } from '../src/shared/protocol';
import { FakeEngineClient, scanned } from './FakeEngineClient';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assessment(
  score: number,
): Pick<EngineResult, 'score' | 'verdict' | 'riskLevel'> {
  return {
    score,
    verdict: score < 30 ? 'CLEAN' : 'SUSPICIOUS',
    riskLevel:
      score < 30
        ? 'BAJO'
        : score < 60
          ? 'MEDIO'
          : score < 85
            ? 'ALTO'
            : 'CRÍTICO',
  };
}

describe('ScanOrchestrator con FakeEngineClient y SQLite temporal', () => {
  let directory: string;
  let database: Database;
  let jobs: ScanJobRepository;
  let results: ScanResultRepository;
  let engine: FakeEngineClient;
  let config: ReturnType<typeof appConfigSchema.parse>;

  beforeEach(() => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-orchestrator-'));
    database = new Database(join(directory, 'test.db'));
    new MigrationRunner(database).run();
    jobs = new ScanJobRepository(database);
    results = new ScanResultRepository(database);
    engine = new FakeEngineClient();
    config = appConfigSchema.parse({
      engine: { requestTimeoutMs: 10_000 },
      scan: { queueCapacity: 2 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
    // Only this test's newly allocated directory is removed.
    rmSync(directory, { recursive: true, force: true });
  });

  function setup(count = 5, overrides: Partial<ScanDependencies> = {}) {
    let discovered = 0;
    const discovery: ScanDiscovery = {
      peakStackSize: 3,
      dirsVisited: 2,
      skippedLinks: 1,
      async *discover() {
        for (let i = 0; i < count; i++) {
          discovered++;
          yield { path: join(directory, `archivo-ñ-${i}.txt`) };
        }
      },
    };
    const orchestrator = new ScanOrchestrator({
      config: () => config,
      engine,
      jobs,
      results,
      createDiscovery: () => discovery,
      sizeOf: async () => 3,
      ...overrides,
    });
    const progress: { value: ScanProgress; at: number }[] = [];
    const finished: ScanJobRecord[] = [];
    orchestrator.on('progress', (value) =>
      progress.push({ value, at: performance.now() }),
    );
    orchestrator.on('finished', (value) => finished.push(value));
    const launch = (kind: 'FILE' | 'FOLDER' = 'FOLDER', path = directory) => {
      const done = new Promise<ScanJobRecord>((resolve) =>
        orchestrator.once('finished', resolve),
      );
      const id = orchestrator.start({ kind, path });
      return { id, done };
    };
    return {
      orchestrator,
      launch,
      progress,
      finished,
      discovered: () => discovered,
    };
  }

  it('top de riesgo en vivo: cada progreso coincide con el top-10 persistido hasta entonces', async () => {
    const scores = [
      40, 90, 80, 90, 30, 60, 85, 90, 75, 80, 50, 100, 95, 90, 90,
    ];
    for (const score of scores) {
      engine.responses.push(async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { ...scanned(params), ...assessment(score) };
      });
    }
    const { launch, progress } = setup(scores.length);
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(400);
    const early = progress.find(({ value }) => value.processed === 1)!.value;
    const earlyCopy = structuredClone(early);
    expect(early.status).not.toBe('COMPLETED');
    expect(early.topRisk).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await done).status).toBe('COMPLETED');
    const rows = results.listByJob(id, 0, 100);
    for (const { value } of progress) {
      const expected = rows
        .slice(0, value.processed)
        .map((row) => ({
          resultId: row.id,
          path: row.path,
          fileName: row.fileName,
          engineScore: scores[row.seq]!,
        }))
        .sort((a, b) => b.engineScore - a.engineScore)
        .slice(0, 10);
      expect(value.topRisk).toEqual(expected);
    }
    expect(early).toEqual(earlyCopy);
    expect(progress.at(-1)!.value.topRisk).toHaveLength(10);
    // El DTO cruza IPC sin estructuras de Node, funciones ni contenido del archivo.
    expect(JSON.parse(JSON.stringify(progress.at(-1)!.value.topRisk))).toEqual(
      progress.at(-1)!.value.topRisk,
    );
  });

  it('top: excluye omitidos, errores y resultados sin score; conserva cero y se reinicia por trabajo', async () => {
    engine.responses.push(
      async (params) => ({ ...scanned(params), ...assessment(0) }),
      async (params) => scanned(params),
      async (params) => ({
        ...scanned(params),
        status: 'ERROR',
        verdict: 'ERROR',
        score: null,
        riskLevel: null,
      }),
      async (params) => ({
        ...scanned(params),
        status: 'SKIPPED',
        verdict: 'NOT_ANALYZED',
        score: null,
        riskLevel: null,
      }),
    );
    const { launch, progress } = setup(4);
    const first = launch();
    await vi.advanceTimersByTimeAsync(250);
    await first.done;
    expect(progress.at(-1)!.value.topRisk).toEqual([
      expect.objectContaining({
        resultId: engine.calls[0]!.params.taskId,
        engineScore: 0,
      }),
    ]);
    const second = launch();
    await vi.advanceTimersByTimeAsync(250);
    await second.done;
    expect(
      progress
        .filter(({ value }) => value.jobId === second.id)
        .every(({ value }) => value.topRisk.length === 0),
    ).toBe(true);
  });

  it('top: un suscriptor no puede alterar el ranking interno', async () => {
    const pending = deferred<EngineResult>();
    engine.responses.push(
      async (params) => ({ ...scanned(params), ...assessment(70) }),
      () => pending.promise,
    );
    const { launch, orchestrator, progress } = setup(2);
    let changed = false;
    orchestrator.on('progress', (value) => {
      if (!changed && value.topRisk.length) {
        value.topRisk[0]!.engineScore = -1;
        value.topRisk[0]!.path = 'ruta-alterada';
        changed = true;
      }
    });
    const { done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect(changed).toBe(true);
    pending.resolve({ ...scanned(engine.calls[1]!.params), ...assessment(90) });
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(
      progress.at(-1)!.value.topRisk.map((item) => item.engineScore),
    ).toEqual([90, 70]);
    expect(
      progress
        .at(-1)!
        .value.topRisk.every((item) => item.path !== 'ruta-alterada'),
    ).toBe(true);
  });

  it('top: nunca publica un resultado cuyo guardado falló', async () => {
    engine.responses.push(async (params) => ({
      ...scanned(params),
      ...assessment(100),
    }));
    const { launch, progress } = setup(1, {
      persistResult: () => {
        throw new Error('BD no disponible');
      },
    });
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect((await done).status).toBe('FAILED');
    expect(results.listByJob(id, 0, 100)).toEqual([]);
    expect(progress.every(({ value }) => value.topRisk.length === 0)).toBe(
      true,
    );
  });

  it('top al cancelar incluye solo el archivo en curso que alcanzó a guardarse', async () => {
    const pending = deferred<EngineResult>();
    engine.responses.push(() => pending.promise);
    const { launch, orchestrator, progress } = setup(20);
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(50);
    const cancel = orchestrator.cancel(id);
    pending.resolve({ ...scanned(engine.calls[0]!.params), ...assessment(85) });
    await vi.advanceTimersByTimeAsync(250);
    await cancel;
    expect((await done).status).toBe('CANCELLED');
    expect(progress.at(-1)!.value.topRisk).toEqual([
      expect.objectContaining({
        resultId: engine.calls[0]!.params.taskId,
        engineScore: 85,
      }),
    ]);
    expect(engine.calls).toHaveLength(1);
  });

  it('FIFO: contadores finales coinciden con filas y veredictos son NOT_EVALUATED (CA-1.2)', async () => {
    engine.responses.push(
      async (params) => ({
        ...scanned(params),
        status: 'ERROR',
        file: undefined,
        hashes: undefined,
        error: { code: 'ACCESS_DENIED', message: 'denegado' },
      }),
      async (params) => ({
        ...scanned(params),
        status: 'SKIPPED',
        file: undefined,
        hashes: undefined,
        error: { code: 'CLOUD_PLACEHOLDER', message: 'nube' },
      }),
    );
    const { launch, progress } = setup(5);
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    const final = await done;
    const rows = results.listByJob(id, 0, 100);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(engine.calls.map((call) => call.params.path)).toEqual(
      rows.map((row) => row.path),
    );
    expect(rows.every((row) => row.verdict === 'NOT_EVALUATED')).toBe(true);
    expect(final).toMatchObject({
      status: 'COMPLETED',
      filesDiscovered: 5,
      filesProcessed: 5,
      filesError: 1,
      filesSkipped: 1,
      bytesProcessed: 9,
    });
    expect(jobs.get(id)).toEqual(final);
    expect(engine.restarts).toBe(0);
    expect(progress.at(-1)?.value).toMatchObject({
      status: 'COMPLETED',
      discoveryDone: true,
      percent: 100,
      processed: 5,
    });
    expect(JSON.parse(final.metricsJson!)).toMatchObject({
      peakStackSize: 3,
      dirsVisited: 2,
      skippedLinks: 1,
      engineRestarts: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('capacidad 2 bloquea descubrimiento y cancelar espera solo el archivo en curso (CA-1.3)', async () => {
    const pending = deferred<EngineResult>();
    engine.responses.push(() => pending.promise);
    const { launch, orchestrator, discovered, finished } = setup(20);
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(50);
    expect(engine.calls).toHaveLength(1);
    expect(discovered()).toBe(4); // one consumer, two queued, one blocked producer
    expect(() => orchestrator.start({ kind: 'FILE', path: 'other' })).toThrow(
      'activo',
    );
    const cancel = orchestrator.cancel(id);
    const repeatCancel = orchestrator.cancel(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toHaveLength(0);
    const fileFinishedAt = performance.now();
    pending.resolve(scanned(engine.calls[0]!.params));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([cancel, repeatCancel]);
    const final = await done;
    expect(final.status).toBe('CANCELLED');
    expect(performance.now() - fileFinishedAt).toBeLessThanOrEqual(2_000);
    expect(final.filesProcessed).toBe(1);
    expect(results.listByJob(id, 0, 100)).toHaveLength(1);
    expect(JSON.parse(final.metricsJson!)).toMatchObject({
      peakQueueSize: 2,
      producerBlockedMs: 50,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(results.listByJob(id, 0, 100)).toHaveLength(1);
    expect(engine.calls).toHaveLength(1);
    expect(engine.restarts).toBe(0);
    await expect(engine.ping()).resolves.toHaveProperty('ts');
    expect(finished).toHaveLength(1);
  });

  it('cancela antes de iniciar y rechaza otro id sin afectar el trabajo', async () => {
    const { launch, orchestrator } = setup();
    const { id, done } = launch();
    await expect(orchestrator.cancel('wrong')).rejects.toThrow(
      'no está activo',
    );
    const cancel = orchestrator.cancel(id);
    await vi.advanceTimersByTimeAsync(250);
    await cancel;
    expect((await done).status).toBe('CANCELLED');
    expect(engine.calls).toHaveLength(0);
    expect(results.listByJob(id, 0, 100)).toEqual([]);
    const second = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect((await second.done).status).toBe('COMPLETED');
  });

  it.each([3, 4])(
    'caídas: %i fallos producen hasta 3 reinicios (CA-1.7)',
    async (failures) => {
      for (let i = 0; i < failures; i++)
        engine.responses.push(async () => {
          throw new Error('proceso terminado');
        });
      const { launch } = setup(6);
      const { id, done } = launch();
      await vi.advanceTimersByTimeAsync(250);
      const final = await done;
      const rows = results.listByJob(id, 0, 100);
      expect(engine.restarts).toBe(3);
      expect(
        rows.filter((row) => row.errorCode === 'ENGINE_CRASHED'),
      ).toHaveLength(failures);
      expect(final.status).toBe(failures === 3 ? 'COMPLETED' : 'FAILED');
      expect(final.filesProcessed).toBe(failures === 3 ? 6 : 4);
      expect(final.filesError).toBe(failures);
      expect(JSON.parse(final.metricsJson!).engineRestarts).toBe(3);
      if (failures === 4) expect(final.errorMessage).toContain('3 reinicios');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('timeout usa tamaño, registra TIMEOUT, reinicia e ignora la respuesta tardía', async () => {
    config.engine.requestTimeoutMs = 100;
    const pending = deferred<EngineResult>();
    engine.responses.push(() => pending.promise);
    const { launch } = setup(2, { sizeOf: async () => 1_048_576 });
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(1_099);
    expect(results.listByJob(id, 0, 100)).toHaveLength(0);
    expect(engine.calls[0]?.timeoutMs).toBe(1_100);
    await vi.advanceTimersByTimeAsync(301);
    expect((await done).status).toBe('COMPLETED');
    const rows = results.listByJob(id, 0, 100);
    expect(rows.map((row) => row.status)).toEqual(['ERROR', 'SCANNED']);
    expect(rows[0]?.errorCode).toBe('TIMEOUT');
    expect(engine.restarts).toBe(1);
    pending.resolve(scanned(engine.calls[0]!.params));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(results.listByJob(id, 0, 100)).toEqual(rows);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('usa timeout base si lstat falla y deja al motor devolver el error del archivo', async () => {
    engine.responses.push(async (params) => ({
      taskId: params.taskId,
      status: 'ERROR',
      evidence: [],
      layers: [],
      durationMs: 0,
      engineVersion: '0.1.0',
      error: { code: 'FILE_NOT_FOUND', message: 'no existe' },
    }));
    const { launch } = setup(1, {
      sizeOf: async () => {
        throw new Error('ENOENT');
      },
    });
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect((await done).status).toBe('COMPLETED');
    expect(engine.calls[0]?.timeoutMs).toBe(config.engine.requestTimeoutMs);
    expect(results.listByJob(id, 0, 10)[0]?.errorCode).toBe('FILE_NOT_FOUND');
  });

  it('emite progreso al menos cada segundo, máximo 5/s, incluso esperando un archivo', async () => {
    const pending = deferred<EngineResult>();
    engine.responses.push(() => pending.promise);
    const { launch, progress } = setup(1);
    const { done } = launch();
    await vi.advanceTimersByTimeAsync(3_100);
    const ongoing = progress.map((entry) => entry.at);
    expect(ongoing).toContain(1_000);
    expect(ongoing).toContain(2_000);
    expect(ongoing).toContain(3_000);
    pending.resolve(scanned(engine.calls[0]!.params));
    await vi.advanceTimersByTimeAsync(300);
    await done;
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.at - progress[i - 1]!.at).toBeGreaterThanOrEqual(200);
      expect(progress[i]!.at - progress[i - 1]!.at).toBeLessThanOrEqual(1_000);
    }
    expect(progress[0]?.value.percent).toBeNull();
    expect(progress.at(-1)?.value.percent).toBe(100);
  });

  it('reinicio fallido termina FAILED y no consume otro archivo', async () => {
    engine.responses.push(async () => {
      throw new Error('muerto');
    });
    engine.onRestart = async () => ({
      status: 'disconnected',
      engineVersion: null,
      protocol: null,
    });
    const { launch } = setup();
    const { done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect((await done).status).toBe('FAILED');
    expect(engine.calls).toHaveLength(1);
    expect(engine.restarts).toBe(1);
  });

  it('un error RPC no se confunde con un error de archivo ni reinicia el motor', async () => {
    engine.responses.push(async () => {
      throw new RpcRemoteError(-32601, 'scan.file no existe');
    });
    const { launch } = setup();
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect((await done).status).toBe('FAILED');
    expect(results.listByJob(id, 0, 100)).toEqual([]);
    expect(engine.restarts).toBe(0);
  });

  it('fallo de descubrimiento detiene ambas fases sin dejar el trabajo activo', async () => {
    const broken: ScanDiscovery = {
      peakStackSize: 0,
      dirsVisited: 0,
      skippedLinks: 0,
      async *discover() {
        yield { path: 'first' };
        throw new Error('discovery failed');
      },
    };
    const { launch, orchestrator } = setup(1, {
      createDiscovery: () => broken,
    });
    const { done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect(await done).toMatchObject({
      status: 'FAILED',
      errorMessage: 'discovery failed',
    });
    expect(() =>
      orchestrator.start({ kind: 'FILE', path: 'next' }),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(250);
  });

  it('cancelar no queda esperando un next de descubrimiento atascado', async () => {
    const pending = deferred<void>();
    const stalled: ScanDiscovery = {
      peakStackSize: 0,
      dirsVisited: 0,
      skippedLinks: 0,
      async *discover() {
        await pending.promise;
        yield { path: 'late' };
      },
    };
    const { launch, orchestrator } = setup(1, {
      createDiscovery: () => stalled,
    });
    const { id, done } = launch();
    await vi.advanceTimersByTimeAsync(0);
    const cancel = orchestrator.cancel(id);
    await vi.advanceTimersByTimeAsync(250);
    await cancel;
    expect((await done).status).toBe('CANCELLED');
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(results.listByJob(id, 0, 10)).toEqual([]);
    expect(engine.calls).toHaveLength(0);
  });

  it('los listeners defectuosos no interrumpen persistencia ni finished', async () => {
    const errors = vi.fn();
    const { launch, orchestrator, finished } = setup(1, { onError: errors });
    orchestrator.prependListener('progress', () => {
      throw new Error('UI failed');
    });
    const { done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect((await done).status).toBe('COMPLETED');
    expect(finished).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
  });

  it('reutiliza FileDiscovery sin modificarlo, con carpeta y archivo reales', async () => {
    vi.useRealTimers();
    const root = join(directory, 'archivos');
    mkdirSync(join(root, 'hijo'), { recursive: true });
    writeFileSync(join(root, 'ñ.txt'), 'abc');
    writeFileSync(join(root, 'hijo', 'á.txt'), 'abc');
    const { launch } = setup(0, {
      createDiscovery: () => new FileDiscovery(),
      sizeOf: undefined,
    });
    const folder = launch('FOLDER', root);
    expect((await folder.done).filesProcessed).toBe(2);
    const file = launch('FILE', join(root, 'ñ.txt'));
    expect((await file.done).filesProcessed).toBe(1);
    expect(results.listByJob(file.id, 0, 10)[0]?.path).toBe(
      join(root, 'ñ.txt'),
    );
    expect(engine.calls.every((call) => call.timeoutMs === 10_001)).toBe(true);
  });

  it('carpeta vacía completa con cero filas y porcentaje 100', async () => {
    const { launch, progress } = setup(0);
    const { done } = launch();
    await vi.advanceTimersByTimeAsync(250);
    expect(await done).toMatchObject({
      status: 'COMPLETED',
      filesDiscovered: 0,
      filesProcessed: 0,
    });
    expect(progress.at(-1)?.value.percent).toBe(100);
  });
});

it('fórmula autorizada: base + ceil(bytes / MiB × 1000), limitada al temporizador Node', () => {
  expect(fileTimeoutMs(30_000, 0)).toBe(30_000);
  expect(fileTimeoutMs(30_000, 1)).toBe(30_001);
  expect(fileTimeoutMs(30_000, 1_572_864)).toBe(31_500);
  expect(fileTimeoutMs(30_000, NaN)).toBe(30_000);
  expect(fileTimeoutMs(30_000, Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
});

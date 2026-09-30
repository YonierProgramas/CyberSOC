import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { ScanOrchestrator } from '../src/core/scan/ScanOrchestrator';
import { appConfigSchema } from '../src/core/config/AppConfig';
import type { CyberSocApi, ScanJobDTO, ScanProgress } from '../src/shared/ipc';
import type { EngineResult } from '../src/shared/protocol';
import { FakeEngineClient, scanned } from './FakeEngineClient';

const electron = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >(),
  listeners: new Map<string, Set<(event: unknown, value: unknown) => void>>(),
  expose: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel),
  },
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (
      channel: string,
      listener: (event: unknown, value: unknown) => void,
    ) => {
      const callbacks = electron.listeners.get(channel) ?? new Set();
      callbacks.add(listener);
      electron.listeners.set(channel, callbacks);
    },
    removeListener: (
      channel: string,
      listener: (event: unknown, value: unknown) => void,
    ) => electron.listeners.get(channel)?.delete(listener),
  },
}));
import { registerScanIpc } from '../src/main/ipc/scan.ipc';

describe('renderer/preload → IPC → ScanOrchestrator → SQLite', () => {
  let directory: string;
  let file: string;
  let database: Database;
  let jobs: ScanJobRepository;
  let results: ScanResultRepository;
  let engine: FakeEngineClient;
  let orchestrator: ScanOrchestrator;
  let api: CyberSocApi;
  let stop: () => Promise<void>;
  let hasWindow: boolean;
  const url = 'file:///cybersoc/out/renderer/index.html';
  const mainFrame = { url };
  const window = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      mainFrame,
      isDestroyed: vi.fn(() => false),
      send: vi.fn((channel: string, value: unknown) => {
        for (const listener of electron.listeners.get(channel) ?? [])
          listener({ sender: 'native event' }, value);
      }),
    },
  };
  const event = {
    sender: window.webContents,
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, sender = event, ...args: unknown[]) =>
    Promise.resolve().then(() =>
      electron.handlers.get(channel)!(sender, ...args),
    );

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    electron.handlers.clear();
    electron.listeners.clear();
    mainFrame.url = url;
    hasWindow = true;
    window.isDestroyed.mockReturnValue(false);
    window.webContents.isDestroyed.mockReturnValue(false);
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-scan-ipc-'));
    file = join(directory, 'niño á 😀.txt');
    writeFileSync(file, 'abc');
    database = new Database(join(directory, 'test.db'));
    new MigrationRunner(database).run();
    jobs = new ScanJobRepository(database);
    results = new ScanResultRepository(database);
    engine = new FakeEngineClient();
    orchestrator = new ScanOrchestrator({
      config: () => appConfigSchema.parse({ scan: { queueCapacity: 2 } }),
      engine,
      jobs,
      results,
      sizeOf: async () => 3,
      createDiscovery: () => ({
        peakStackSize: 1,
        dirsVisited: 1,
        skippedLinks: 0,
        async *discover() {
          yield { path: file };
          yield { path: file };
        },
      }),
    });
    stop = registerScanIpc(
      () => (hasWindow ? (window as unknown as BrowserWindow) : null),
      url,
      orchestrator,
      database,
    );
    electron.invoke.mockImplementation((channel: string, ...args: unknown[]) =>
      invoke(channel, event, ...args),
    );
    vi.resetModules();
    await import('../src/preload/index');
    api = electron.expose.mock.calls.at(-1)![1] as CyberSocApi;
  });

  afterEach(async () => {
    const stopping = stop();
    await vi.runAllTimersAsync();
    await stopping;
    vi.useRealTimers();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('el renderer inicia, recibe progreso, consulta historial y pagina resultados', async () => {
    const progress: ScanProgress[] = [];
    const finished: ScanJobDTO[] = [];
    const offProgress = api.scan.onProgress((value) => progress.push(value));
    const offFinished = api.scan.onFinished((value) => finished.push(value));
    const { jobId } = await api.scan.start({ kind: 'FILE', path: file });
    await vi.advanceTimersByTimeAsync(250);
    expect(progress.length).toBeGreaterThan(0);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      id: jobId,
      status: 'COMPLETED',
      filesProcessed: 2,
    });
    await expect(api.scan.getJob(jobId)).resolves.toEqual(finished[0]);
    await expect(api.scan.listJobs(1)).resolves.toEqual([finished[0]]);
    const first = await api.scan.listResults({ jobId, offset: 0, limit: 1 });
    const second = await api.scan.listResults({ jobId, offset: 1, limit: 1 });
    expect(first).toMatchObject({
      offset: 0,
      limit: 1,
      total: 2,
      items: [{ seq: 0, verdict: 'NOT_EVALUATED' }],
    });
    expect(second).toMatchObject({
      offset: 1,
      limit: 1,
      total: 2,
      items: [{ seq: 1 }],
    });
    await expect(
      api.scan.listResults({ jobId, offset: 2, limit: 200 }),
    ).resolves.toMatchObject({ items: [], total: 2 });
    offProgress();
    offFinished();
    const observed = progress.length;
    window.webContents.send('scan:progress', { marker: 'late' });
    expect(progress).toHaveLength(observed);
  });

  it('el renderer cancela y se desuscribe sin resultados posteriores a CANCELLED', async () => {
    let resolve!: (value: EngineResult) => void;
    engine.responses.push(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const callback = vi.fn();
    const unsubscribe = api.scan.onFinished(callback);
    const { jobId } = await api.scan.start({ kind: 'FOLDER', path: directory });
    await vi.advanceTimersByTimeAsync(0);
    const cancel = api.scan.cancel(jobId);
    await vi.advanceTimersByTimeAsync(0);
    await expect(api.scan.getJob(jobId)).resolves.toMatchObject({
      status: 'CANCELLING',
    });
    resolve(scanned(engine.calls[0]!.params));
    await vi.advanceTimersByTimeAsync(250);
    await cancel;
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: jobId, status: 'CANCELLED' }),
    );
    unsubscribe();
    const before = await api.scan.listResults({ jobId, offset: 0, limit: 200 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(
      api.scan.listResults({ jobId, offset: 0, limit: 200 }),
    ).resolves.toEqual(before);
    expect(before.total).toBe(1);
  });

  it.each([
    ['scan:start', []],
    ['scan:start', [{ kind: 'FILE', path: 'relative.txt' }]],
    ['scan:start', [{ kind: 'BAD', path: 'C:\\file' }]],
    ['scan:start', [null]],
    ['scan:cancel', []],
    ['scan:cancel', ['']],
    ['scan:cancel', ['id', 'extra']],
    ['scan:getJob', [5]],
    ['scan:getJob', ['']],
    ['scan:getJob', ['id', {}]],
    ['scan:listJobs', [-1]],
    ['scan:listJobs', [1.5]],
    ['scan:listJobs', ['20']],
    ['scan:listJobs', [1, 2]],
    ['scan:listResults', [{ jobId: 'id', offset: 0, limit: 201 }]],
    ['scan:listResults', [{ jobId: 'id', offset: -1, limit: 1 }]],
    ['scan:listResults', [{ jobId: 'id', offset: 0, limit: 0 }]],
    ['scan:listResults', [{ jobId: 'id', offset: 0.5, limit: 1 }]],
    ['scan:listResults', [{ jobId: 'id', offset: 0, limit: 1, sql: 'extra' }]],
    ['scan:listResults', [{ jobId: '', offset: 0, limit: 1 }]],
  ] as const)('rechaza entrada inválida de %s (%j)', async (channel, args) => {
    await expect(invoke(channel, event, ...args)).rejects.toThrow();
    expect(engine.calls).toHaveLength(0);
    expect(jobs.listRecent()).toEqual([]);
  });

  it('rechaza destinos inexistentes o con tipo incorrecto y campos adicionales', async () => {
    for (const target of [
      { kind: 'FILE', path: join(directory, 'missing') },
      { kind: 'FILE', path: directory },
      { kind: 'FOLDER', path: file },
      { kind: 'FILE', path: file, extra: true },
    ])
      await expect(invoke('scan:start', event, target)).rejects.toThrow();
    expect(jobs.listRecent()).toEqual([]);
  });

  it.each([
    'scan:start',
    'scan:cancel',
    'scan:getJob',
    'scan:listJobs',
    'scan:listResults',
  ])('valida remitente, frame, URL y ventana en %s', async (channel) => {
    await expect(
      invoke(channel, { ...event, sender: {} } as IpcMainInvokeEvent),
    ).rejects.toThrow('Origen IPC');
    await expect(
      invoke(channel, { ...event, senderFrame: {} } as IpcMainInvokeEvent),
    ).rejects.toThrow('Origen IPC');
    mainFrame.url = 'about:blank';
    await expect(invoke(channel)).rejects.toThrow('Origen IPC');
    mainFrame.url = url;
    hasWindow = false;
    await expect(invoke(channel)).rejects.toThrow('Origen IPC');
    expect(engine.calls).toHaveLength(0);
  });

  it('un trabajo inexistente devuelve un error y total cuenta filas reales', async () => {
    await expect(api.scan.getJob('missing')).rejects.toThrow('No existe');
    await expect(
      api.scan.listResults({ jobId: 'missing', offset: 0, limit: 1 }),
    ).rejects.toThrow('No existe');
    jobs.create({ id: 'stored', targetKind: 'FILE', targetPath: file });
    results.insertResult({
      id: 'r1',
      jobId: 'stored',
      seq: 0,
      path: file,
      fileName: 'ñ.txt',
      status: 'ERROR',
      errorCode: 'ACCESS_DENIED',
    });
    // Deliberately leave filesProcessed=0 to model an interrupted legacy update.
    await expect(
      api.scan.listResults({ jobId: 'stored', offset: 0, limit: 200 }),
    ).resolves.toMatchObject({ total: 1, items: [{ id: 'r1' }] });
  });

  it('no envía eventos a ventanas destruidas o que cambiaron de URL', () => {
    const progress = { jobId: 'j1' } as ScanProgress;
    mainFrame.url = 'about:blank';
    orchestrator.emit('progress', progress);
    mainFrame.url = url;
    window.isDestroyed.mockReturnValue(true);
    orchestrator.emit('progress', progress);
    window.isDestroyed.mockReturnValue(false);
    window.webContents.isDestroyed.mockReturnValue(true);
    orchestrator.emit('progress', progress);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('desmontar el IPC cancela el trabajo activo antes de liberar la base', async () => {
    let resolve!: (value: EngineResult) => void;
    engine.responses.push(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { jobId } = await api.scan.start({ kind: 'FILE', path: file });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = stop();
    expect(electron.handlers.size).toBe(0);
    expect(orchestrator.listenerCount('progress')).toBe(0);
    expect(orchestrator.listenerCount('finished')).toBe(0);
    resolve(scanned(engine.calls[0]!.params));
    await vi.advanceTimersByTimeAsync(250);
    await stopping;
    expect(jobs.get(jobId)?.status).toBe('CANCELLED');
    expect(engine.calls).toHaveLength(1);
  });
});

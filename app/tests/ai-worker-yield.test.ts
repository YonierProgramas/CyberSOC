import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { AIAnalysisStore } from '../src/core/ai/AIAnalysisStore';
import { AIAnalysisWorker } from '../src/core/ai/AIAnalysisWorker';
import { AISecurityService } from '../src/core/ai/AISecurityService';
import { appConfigSchema } from '../src/core/config/AppConfig';

let root: string;
let db: Database;
let store: AIAnalysisStore;
let service: AISecurityService;
const workers: AIAnalysisWorker[] = [];
const count = 32;
const checkPhase = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cybersoc-worker-yield-'));
  db = new Database(join(root, 'test.sqlite'));
  new MigrationRunner(db).run();
  new ScanJobRepository(db).create({
    id: 'job',
    targetKind: 'FOLDER',
    targetPath: 'C:\\Sintetico',
    createdAt: '2026-11-04T12:00:00.000Z',
  });
  const results = new ScanResultRepository(db);
  for (let seq = 0; seq < count; seq++)
    results.insertResult({
      id: `r-${seq}`,
      jobId: 'job',
      seq,
      path: 'C:\\Sintetico\\texto.txt',
      fileName: 'texto.txt',
      status: 'SCANNED',
      verdict: seq % 3 === 0 ? 'DETECTED' : 'SUSPICIOUS',
      engineScore: seq % 4,
      aiStatus: 'PENDING',
      scannedAt: '2026-11-04T12:00:00.000Z',
    });
  store = new AIAnalysisStore(db);
  service = new AISecurityService(
    store,
    () => null,
    () => appConfigSchema.parse({}),
  );
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function worker() {
  const value = new AIAnalysisWorker(service);
  workers.push(value);
  return value;
}

function fastService() {
  // Service double to isolate scheduling: SQLite and heap are real;
  // neither the AI response nor RiskPolicy are verified with this double.
  return vi.spyOn(service, 'analyze').mockImplementation(async (id) => {
    store.setStatus(id, 'COMPLETED');
    return { status: 'COMPLETED' };
  });
}

it('yields to the event-loop check before exhausting immediate responses; keeps priority/FIFO and unique IDs', async () => {
  const analyze = fastService();
  // Oracle sorted array: O(n log n); Set holds each ID once,
  // expected O(n) build/O(n) memory, expected O(1) lookup.
  const expected = Array.from({ length: count }, (_, seq) => ({
    id: `r-${seq}`,
    seq,
    priority: (seq % 4) + (seq % 3 === 0 ? 100 : 0),
  }))
    .sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    .map((row) => row.id);
  const value = worker();
  value.start();
  await checkPhase();
  expect(analyze.mock.calls.length).toBeGreaterThan(0);
  expect(analyze.mock.calls.length).toBeLessThan(count);
  await vi.waitFor(() => expect(value.state.pending).toBe(0));
  expect(analyze.mock.calls.map(([id]) => id)).toEqual(expected);
  expect(new Set(analyze.mock.calls.map(([id]) => id)).size).toBe(count);
});

it('stop cancels the continuation; persisted pending items are recovered once on restart', async () => {
  const analyze = fastService();
  const first = worker();
  first.start();
  await checkPhase();
  await first.stop();
  const finished = analyze.mock.calls.length;
  expect(finished).toBeLessThan(count);
  await checkPhase();
  expect(analyze).toHaveBeenCalledTimes(finished);
  const pending = db
    .prepare("SELECT COUNT(*) n FROM scan_results WHERE ai_status='PENDING'")
    .get()!.n;
  expect(pending).toBe(count - finished);
  // Actually reopen SQLite; the new instance does not depend on the old heap.
  db.close();
  db = new Database(join(root, 'test.sqlite'));
  store = new AIAnalysisStore(db);
  service = new AISecurityService(
    store,
    () => null,
    () => appConfigSchema.parse({}),
  );
  const resumed = fastService();
  const second = worker();
  second.start();
  await vi.waitFor(() => expect(second.state.pending).toBe(0));
  const ids = [
    ...analyze.mock.calls.map(([id]) => id),
    ...resumed.mock.calls.map(([id]) => id),
  ];
  expect(ids).toHaveLength(count);
  expect(new Set(ids).size).toBe(count);
  expect(
    db
      .prepare(
        "SELECT COUNT(*) n FROM scan_results WHERE ai_status='COMPLETED'",
      )
      .get()!.n,
  ).toBe(count);
});

it('stop aborts the task in progress, restores PENDING and starts no other continuation', async () => {
  let started!: (id: string) => void;
  const inFlight = new Promise<string>((resolve) => {
    started = resolve;
  });
  const analyze = vi
    .spyOn(service, 'analyze')
    .mockImplementation(async (id, signal) => {
      store.setStatus(id, 'RUNNING');
      started(id);
      await new Promise<void>((_, reject) => {
        signal!.addEventListener(
          'abort',
          () => reject(new Error('Cancelación del doble de servicio.')),
          { once: true },
        );
      });
      return { status: 'COMPLETED' };
    });
  const value = worker();
  value.start();
  const id = await inFlight;
  expect(store.results.get(id)?.aiStatus).toBe('RUNNING');
  await value.stop();
  await checkPhase();
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(store.results.get(id)?.aiStatus).toBe('PENDING');
  expect(
    db
      .prepare("SELECT COUNT(*) n FROM scan_results WHERE ai_status='PENDING'")
      .get()!.n,
  ).toBe(count);
});

it('a higher-risk addition between tasks keeps priority and is not duplicated by reentry', async () => {
  const analyze = fastService();
  const value = worker();
  value.start();
  await checkPhase();
  expect(analyze).toHaveBeenCalledTimes(1);
  new ScanResultRepository(db).insertResult({
    id: 'late',
    jobId: 'job',
    seq: count,
    path: 'C:\\Sintetico\\otro.txt',
    fileName: 'otro.txt',
    status: 'SCANNED',
    verdict: 'DETECTED',
    engineScore: 100,
    aiStatus: 'NOT_REQUIRED',
  });
  value.analyzeNow('late');
  value.analyzeNow('late');
  await vi.waitFor(() => expect(value.state.pending).toBe(0));
  const ids = analyze.mock.calls.map(([id]) => id);
  expect(ids[1]).toBe('late');
  expect(ids).toHaveLength(count + 1);
  expect(new Set(ids).size).toBe(count + 1);
});

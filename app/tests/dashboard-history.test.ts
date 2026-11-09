import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { DashboardReader } from '../src/core/dashboard/DashboardReader';
import {
  localStart,
  localEndExclusive,
} from '../src/core/dashboard/localDates';
import { seedHistory } from './fixtures/history';

let root: string, db: Database, reader: DashboardReader;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cybersoc-history-'));
  db = new Database(join(root, 'fixture.sqlite'));
  new MigrationRunner(db).run();
  reader = new DashboardReader(db, () => new Date('2026-11-04T17:00:00.000Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it('I-02/I-05/I-19: 250 jobs/30000 results/400 days; three complete scopes and SQL oracle', () => {
  const manifest = seedHistory(db);
  expect(manifest[1]!.results).toBe(30);
  const result = reader.getOverview({ from: '2026-10-29', to: '2026-11-04' });
  expect(result.allTime).toMatchObject({
    jobs: 250,
    results: 30000,
    firstJobAt: manifest[0]!.createdAt,
  });
  for (const scope of [
    result.distributions.allCompleted,
    result.distributions.range,
    result.distributions.lastCompleted!,
  ]) {
    const r = scope.results;
    for (const counts of [r.byVerdict, r.byStatus, r.byAiStatus])
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(r.total);
    expect(r.byZone.reduce((sum, zone) => sum + zone.results, 0)).toBe(r.total);
  }
  const { allCompleted, range, lastCompleted } = result.distributions;
  const oracle = db
    .prepare(
      "SELECT COUNT(*) total FROM scan_results WHERE job_id IN (SELECT id FROM scan_jobs WHERE status='COMPLETED')",
    )
    .get()!.total;
  expect(allCompleted.results.total).toBe(oracle);
  expect(allCompleted.results.total + allCompleted.excluded.results).toBe(
    30000,
  );
  expect(allCompleted.jobs + allCompleted.excluded.jobs).toBe(250);
  expect(allCompleted.results.total).toBeGreaterThan(range.results.total);
  expect(result.active?.id).not.toBe(lastCompleted?.job.id);
  expect(range.partial).toBe(true);
  expect(allCompleted.partial).toBe(false);
  expect(result.activity.daily.reduce((sum, day) => sum + day.results, 0)).toBe(
    range.results.total,
  );
  expect(result.activity.daily.reduce((sum, day) => sum + day.jobs, 0)).toBe(
    result.activity.jobs.total,
  );
  const grouped = db
    .prepare(
      "SELECT verdict, COUNT(*) total FROM scan_results WHERE job_id IN (SELECT id FROM scan_jobs WHERE status='COMPLETED') GROUP BY verdict",
    )
    .all();
  for (const row of grouped)
    expect(
      allCompleted.results.byVerdict[
        row.verdict as keyof typeof allCompleted.results.byVerdict
      ],
    ).toBe(row.total);
  const from = localStart('2026-10-29'),
    to = localEndExclusive('2026-11-04');
  const rangeOracle = db
    .prepare(
      'SELECT COUNT(*) total FROM scan_results WHERE job_id IN (SELECT id FROM scan_jobs WHERE created_at>=? AND created_at<?)',
    )
    .get(from, to)!.total;
  expect(range.results.total).toBe(rangeOracle);
});

it('I-03: zeros and complete keys, 366 valid days, 367/inversion/impossible date rejected', () => {
  const repo = new ScanJobRepository(db);
  repo.create({
    id: 'old',
    targetKind: 'FILE',
    targetPath: 'C:\\Sintetico',
    createdAt: '2024-01-01T12:00:00.000Z',
  });
  repo.updateStatus('old', 'COMPLETED', {
    finishedAt: '2024-01-01T12:01:00.000Z',
  });
  const value = reader.getOverview();
  expect(value.activity.daily).toHaveLength(7);
  expect(
    value.activity.daily.every((day) => day.jobs === 0 && day.results === 0),
  ).toBe(true);
  expect(value.distributions.lastCompleted?.job.id).toBe('old');
  expect(Object.keys(value.distributions.range.results.byVerdict)).toHaveLength(
    5,
  );
  expect(Object.keys(value.distributions.range.results.byStatus)).toHaveLength(
    3,
  );
  expect(
    Object.keys(value.distributions.range.results.byAiStatus),
  ).toHaveLength(8);
  expect(
    reader.getOverview({ from: '2024-01-01', to: '2024-12-31' }).range.days,
  ).toBe(366);
  expect(() =>
    reader.getOverview({ from: '2024-01-01', to: '2025-01-01' }),
  ).toThrow('INVALID_RANGE');
  expect(() =>
    reader.getOverview({ from: '2026-11-05', to: '2026-11-04' }),
  ).toThrow('INVALID_RANGE');
  expect(() => reader.getOverview({ from: '2026-02-30' })).toThrow();
  expect(() => reader.getOverview({ extra: 1 } as never)).toThrow();
});

it('I-05: failed job with 30 results excluded and never turned into clean; latest global separate', () => {
  const repo = new ScanJobRepository(db);
  for (const [id, status, date] of [
    ['complete', 'COMPLETED', '2025-01-01'],
    ['failed', 'FAILED', '2026-11-03'],
    ['active', 'SCANNING', '2026-11-04'],
  ] as const) {
    repo.create({
      id,
      targetKind: 'FILE',
      targetPath: 'C:\\Sintetico',
      createdAt: `${date}T12:00:00.000Z`,
    });
    repo.updateStatus(
      id,
      status,
      status === 'SCANNING' ? {} : { finishedAt: `${date}T12:01:00.000Z` },
    );
  }
  const insert = db.prepare(
    "INSERT INTO scan_results(id,job_id,seq,path,file_name,status,verdict,scanned_at) VALUES (?,'failed',?,'sintetico','sintetico','ERROR','NOT_ANALYZED','2026-11-03T12:00:00.000Z')",
  );
  db.transaction(() => {
    for (let i = 0; i < 30; i++) insert.run(`r${i}`, i);
  });
  const value = reader.getOverview();
  expect(value.distributions.lastCompleted?.job.id).toBe('complete');
  expect(value.distributions.lastCompleted?.excluded).toMatchObject({
    jobs: 1,
    results: 30,
  });
  expect(value.distributions.allCompleted.excluded).toMatchObject({
    jobs: 2,
    results: 30,
  });
  expect(value.distributions.range.results).toMatchObject({
    total: 30,
    byVerdict: { CLEAN: 0, NOT_ANALYZED: 30 },
    byStatus: { ERROR: 30 },
  });
});

it('I-06: pages 20/20/5, total 45 and filters over the whole history; strict limits', () => {
  seedHistory(db, 45, 90);
  const repo = new ScanJobRepository(db);
  const pages = [0, 20, 40].map((offset) =>
    repo.listPage({ offset, limit: 20 }),
  );
  expect(pages.map((page) => page.items.length)).toEqual([20, 20, 5]);
  expect(pages.every((page) => page.total === 45)).toBe(true);
  expect(
    new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size,
  ).toBe(45);
  expect(pages[2]!.items.some((item) => item.createdAt < '2025-11-04')).toBe(
    true,
  );
  const filtered = repo.listPage({
    offset: 0,
    limit: 200,
    statuses: ['COMPLETED'],
  });
  expect(filtered.items.every((item) => item.status === 'COMPLETED')).toBe(
    true,
  );
  expect(filtered.items).toHaveLength(filtered.total);
  expect(repo.listPage({ offset: 0, limit: 200, statuses: [] }).total).toBe(45);
  for (const input of [
    { limit: 0 },
    { limit: 201 },
    { offset: -1 },
    { offset: 1.5 },
    { statuses: ['FAILED', 'FAILED'] },
    { extra: true },
    { from: '2026-02-30' },
  ])
    expect(() =>
      repo.listPage({ offset: 0, limit: 20, ...input } as never),
    ).toThrow();
  expect(
    repo.listPage({ offset: 0, limit: 200, to: '2025-11-04' }).items.length,
  ).toBeGreaterThan(0);
});

it('coherent WAL read allows a writer and forbids writes, restoring query_only on failure', () => {
  const writer = new DatabaseSync(db.path);
  try {
    db.exec("INSERT INTO settings VALUES ('before','{}','before')");
    db.readTransaction(() => {
      expect(db.prepare('SELECT COUNT(*) n FROM settings').get()!.n).toBe(1);
      writer.exec("INSERT INTO settings VALUES ('during','{}','during')");
      expect(db.prepare('SELECT COUNT(*) n FROM settings').get()!.n).toBe(1);
      expect(() =>
        db.exec("INSERT INTO settings VALUES ('bad','{}','bad')"),
      ).toThrow();
      expect(() => db.transaction(() => undefined)).toThrow('Cannot write');
    });
    expect(db.prepare('SELECT COUNT(*) n FROM settings').get()!.n).toBe(2);
    expect(() =>
      db.readTransaction(() => {
        throw new Error('fallo');
      }),
    ).toThrow('fallo');
    expect(() => db.readTransaction(() => Promise.resolve())).toThrow(
      'synchronous',
    );
    db.exec("INSERT INTO settings VALUES ('after','{}','after')");
  } finally {
    writer.close();
  }
});

it('I-04: midnight, a job crossing days and DST in independent Bogota/New York processes', () => {
  const appRoot = resolve(import.meta.dirname, '..');
  for (const timezone of ['America/Bogota', 'America/New_York']) {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        './tests/history-register.mjs',
        'scripts/check-history-dates.ts',
      ],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          TZ: timezone,
          CI: 'true',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        windowsHide: true,
        encoding: 'utf8',
      },
    );
    const value = JSON.parse(output.trim());
    expect(value).toMatchObject({
      status: 'PASS',
      requestedTimezone: timezone,
      rangeDays: 2,
    });
    expect(['America/Bogota', 'America/New_York']).toContain(
      value.actualTimezone,
    );
  }
});

it('dashboard does not mix its aggregates when another connection commits a result between SELECTs', () => {
  seedHistory(db, 3, 6);
  const writer = new DatabaseSync(db.path);
  const prepare = db.prepare.bind(db);
  let injected = false;
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (!injected && sql === 'SELECT COUNT(*) total FROM scan_results') {
      injected = true;
      writer.exec(
        "INSERT INTO scan_results(id,job_id,seq,path,file_name,status,verdict,scanned_at) VALUES ('concurrent','history-00000',999,'sintetico','sintetico','SCANNED','CLEAN','2026-11-04T12:00:00.000Z')",
      );
    }
    return prepare(sql);
  });
  try {
    const before = reader.getOverview();
    expect(injected).toBe(true);
    expect(before.allTime.results).toBe(6);
    const after = reader.getOverview();
    expect(after.allTime.results).toBe(7);
    expect(after.distributions.allCompleted.results.total).toBe(
      before.distributions.allCompleted.results.total + 1,
    );
  } finally {
    writer.close();
  }
});

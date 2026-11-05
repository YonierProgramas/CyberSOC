import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { DashboardReader } from '../src/core/dashboard/DashboardReader';
import {
  localDateKey,
  localStart,
  localEndExclusive,
} from '../src/core/dashboard/localDates';

const root = mkdtempSync(join(tmpdir(), 'cybersoc-history-dates-'));
const db = new Database(join(root, 'dates.sqlite'));
try {
  new MigrationRunner(db).run();
  const jobs = new ScanJobRepository(db);
  for (const [id, local] of [
    ['before', '2026-11-01T23:59:00'],
    ['after', '2026-11-02T00:01:00'],
  ] as const) {
    jobs.create({
      id,
      targetKind: 'FILE',
      targetPath: 'C:\\Sintetico',
      createdAt: new Date(local).toISOString(),
    });
    jobs.updateStatus(id, 'COMPLETED', {
      finishedAt: new Date('2026-11-02T02:00:00').toISOString(),
    });
    db.prepare(
      "INSERT INTO scan_results(id,job_id,seq,path,file_name,status,verdict,scanned_at) VALUES(?,?,0,'sintetico','sintetico','SCANNED','CLEAN',?)",
    ).run(`result-${id}`, id, new Date(local).toISOString());
  }
  const reader = new DashboardReader(db);
  const result = reader.getOverview({ from: '2026-11-01', to: '2026-11-02' });
  assert.deepEqual(
    result.activity.daily.map((day) => [day.date, day.jobs, day.results]),
    [
      ['2026-11-01', 1, 1],
      ['2026-11-02', 1, 1],
    ],
  );
  assert.equal(
    jobs.listPage({
      offset: 0,
      limit: 20,
      from: '2026-11-02',
      to: '2026-11-02',
    }).total,
    1,
  );
  const durationHours =
    (Date.parse(localEndExclusive('2026-11-01')) -
      Date.parse(localStart('2026-11-01'))) /
    3_600_000;
  assert.equal(durationHours, process.env.TZ === 'America/New_York' ? 25 : 24);
  assert.equal(localDateKey(new Date('2026-11-02T00:01:00')), '2026-11-02');
  console.log(
    JSON.stringify({
      status: 'PASS',
      requestedTimezone: process.env.TZ,
      actualTimezone: result.timezone,
      durationHours,
      daily: result.activity.daily,
      rangeDays: result.range.days,
    }),
  );
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SQLInputValue } from 'node:sqlite';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { DashboardReader } from '../src/core/dashboard/DashboardReader';
import { seedHistory } from '../tests/fixtures/history';
const root = mkdtempSync(join(tmpdir(), 'cybersoc-profile-history-'));
const db = new Database(join(root, 'profile.sqlite'));
try {
  new MigrationRunner(db).run();
  seedHistory(db, 1000, 100000);
  const prepare = db.prepare.bind(db);
  const queries: { sql: string; method: string; ms: number; plan: unknown }[] =
    [];
  db.prepare = (sql) => {
    const statement = prepare(sql);
    for (const method of ['get', 'all'] as const) {
      const read = statement[method].bind(statement);
      Object.defineProperty(statement, method, {
        value: (...args: SQLInputValue[]) => {
          const start = performance.now();
          const result = read(...args);
          const ms = performance.now() - start;
          let plan: unknown = null;
          if (sql.trimStart().startsWith('SELECT'))
            plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(...args);
          queries.push({ sql, method, ms, plan });
          return result;
        },
      });
    }
    return statement;
  };
  const start = performance.now();
  new DashboardReader(db).getOverview({ from: '2026-10-29', to: '2026-11-04' });
  const wallMs = performance.now() - start;
  const output = resolve(
    import.meta.dirname,
    '../../../construccion/sprints/sprint-10-escritorio-historial/evidencias/10B-datos/08-perfil-consultas.json',
  );
  writeFileSync(
    output,
    JSON.stringify(
      { wallMs, sqlMs: queries.reduce((s, q) => s + q.ms, 0), queries },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      wallMs,
      queries: queries
        .filter((q) => q.ms > 10)
        .map((q) => ({ sql: q.sql, ms: q.ms, plan: q.plan })),
    }),
  );
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

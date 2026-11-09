import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir, cpus, totalmem, release, platform } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { DashboardReader } from '../src/core/dashboard/DashboardReader';
import { ConversationArchiveReader } from '../src/core/persistence/ConversationArchiveReader';
import { ConversationRepository } from '../src/core/persistence/ConversationRepository';
import {
  dashboardOverviewSchema,
  messagesPageSchema,
} from '../src/shared/history-schemas';
import {
  seedHistory,
  seedMessages,
  cardAtBytes,
} from '../tests/fixtures/history';

const appRoot = resolve(import.meta.dirname, '..');
const evidence = resolve(
  appRoot,
  '../../construccion/sprints/sprint-10-escritorio-historial/evidencias/10B-datos',
);
const output = resolve(evidence, process.argv[2] ?? '07-rendimiento.json');
assert.ok(output.startsWith(evidence + sep), 'Salida fuera de evidencia B');
assert.ok(
  !existsSync(output),
  'Conservar campañas anteriores: elegir otro nombre',
);
const root = mkdtempSync(join(tmpdir(), 'cybersoc-history-benchmark-'));
let db = new Database(join(root, 'benchmark.sqlite'));
const run = <T>(operation: () => T) => {
  const start = performance.now();
  const value = operation();
  return { ms: performance.now() - start, value };
};
function campaign(operation: () => unknown, budgetMs: number) {
  const first = run(operation).ms;
  for (let i = 0; i < 5; i++) operation();
  const samples = Array.from({ length: 30 }, () => run(operation).ms);
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    firstReadMs: first,
    warmups: 5,
    samples,
    min: sorted[0]!,
    median: (sorted[14]! + sorted[15]!) / 2,
    p95: sorted[28]!,
    max: sorted[29]!,
    budgetMs,
    pass: samples.every((ms) => ms < budgetMs),
  };
}
try {
  new MigrationRunner(db).run();
  seedHistory(db, 1000, 100_000);
  const chat = seedMessages(db, 10_000);
  // Preparation stays outside all measured intervals.
  db.close();
  db = new Database(db.path);
  const dashboard = new DashboardReader(
    db,
    () => new Date('2026-11-04T17:00:00.000Z'),
  );
  const archive = new ConversationArchiveReader(db);
  const rssBefore = process.memoryUsage().rss;
  const dashboardTimes = campaign(
    () =>
      dashboardOverviewSchema.parse(
        dashboard.getOverview({ from: '2026-10-29', to: '2026-11-04' }),
      ),
    500,
  );
  const messagesTimes = campaign(
    () =>
      messagesPageSchema.parse(archive.listMessages({ conversationId: chat })),
    50,
  );
  const repo = new ConversationRepository(db);
  const large = repo.create('30 tarjetas de 1 MiB').id;
  const card = cardAtBytes(1024 * 1024);
  db.transaction(() => {
    for (let i = 0; i < 30; i++)
      repo.appendAnsweredWithCard(large, { content: `sintético ${i}` }, card);
  });
  const worstPage = run(() =>
    messagesPageSchema.parse(
      archive.listMessages({ conversationId: large, limit: 100 }),
    ),
  );
  const result = {
    date: '2026-11-04',
    baseSha: 'd1db366341aea04b99d806185c70501104b92d10',
    pendingChanges: true,
    environment: {
      platform: platform(),
      windowsRelease: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
      versions: process.versions,
      electronInstalled: JSON.parse(
        readFileSync(
          join(appRoot, 'node_modules/electron/package.json'),
          'utf8',
        ),
      ).version,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      load: 'No se instrumentó carga externa; equipo de desarrollo con otros procesos posibles.',
    },
    method:
      'performance.now: lector main + validación de salida IPC; SQL/DTO reales, sin red; no incluye transporte Electron/render. Primera lectura con conexión nueva, sin vaciar caché del SO; 5 calentamientos y 30 muestras sin descartes/sleeps.',
    fixture: {
      deterministic: true,
      anchor: '2026-11-04',
      historyDays: 400,
      jobs: 1000,
      results: 100000,
      messages: 10000,
      largeMessages: 30,
      cardBytes: 1048576,
    },
    database: {
      mainBytes: statSync(db.path).size,
      walBytes: existsSync(db.path + '-wal')
        ? statSync(db.path + '-wal').size
        : 0,
      indexes: db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name",
        )
        .all(),
    },
    plans: {
      dashboard: db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT r.verdict,r.status,r.ai_status,COUNT(*) FROM scan_jobs j CROSS JOIN scan_results r INDEXED BY idx_results_job WHERE r.job_id=j.id AND j.status='COMPLETED' GROUP BY r.verdict,r.status,r.ai_status",
        )
        .all(),
      zones: db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT r.zone,COUNT(*) FROM scan_jobs j CROSS JOIN scan_results r INDEXED BY idx_results_job WHERE r.job_id=j.id AND j.status='COMPLETED' GROUP BY r.zone",
        )
        .all(),
      messages: db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT rowid,id FROM ai_messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 31',
        )
        .all(chat),
    },
    dashboard: dashboardTimes,
    messages: messagesTimes,
    worstPage: {
      ms: worstPage.ms,
      items: worstPage.value.items.length,
      envelopeBytes: Buffer.byteLength(JSON.stringify(worstPage.value)),
      cardBytes: worstPage.value.items.reduce(
        (sum, item) =>
          sum +
          (item.kind === 'ASSISTANT' && item.card
            ? Buffer.byteLength(JSON.stringify(item.card))
            : 0),
        0,
      ),
      budgetApplies: false,
    },
    memory: {
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    },
    pass: dashboardTimes.pass && messagesTimes.pass,
  };
  writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      output,
      pass: result.pass,
      dashboard: { p95: dashboardTimes.p95, max: dashboardTimes.max },
      messages: { p95: messagesTimes.p95, max: messagesTimes.max },
      worstPage: result.worstPage,
    }),
  );
  if (!result.pass) process.exitCode = 1;
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

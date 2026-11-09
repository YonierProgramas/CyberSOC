import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from 'playwright/test';
import type { CyberSocApi } from '../../src/shared/ipc';
import { buildSyntheticProfile } from './synthetic-profile';

const appRoot = resolve(import.meta.dirname, '../..');
// Results and captures: folder chosen with CYBERSOC_E2E_EVIDENCE_DIR or, by default,
// a temporary one. The test reads nothing from construccion/, which is not in the repository.
const evidence = resolve(
  process.env.CYBERSOC_E2E_EVIDENCE_DIR ??
    join(tmpdir(), 'cybersoc-e2e-correcciones'),
);
const require = createRequire(join(appRoot, 'package.json'));
const results: { name: string; value: unknown }[] = [];
let app: ElectronApplication;
let page: Page;
let root: string;
let dbPath: string;
const chatId = (n: number) =>
  `d0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const title = (n: number) => `D-CHAT-${String(n).padStart(2, '0')}`;
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
interface Controls {
  counts: Record<string, number>;
  holds: { channel: string; key: string }[];
  pending: { channel: string; key: string; resolve: () => void }[];
  fail: { channel: string; key: string } | null;
  deferredErrors: { channel: string; key: string }[];
  planPath: string | null;
  busyQuarantine: boolean;
}
function record(name: string, value: unknown) {
  results.push({ name, value });
  writeFileSync(
    join(evidence, '06-resultados.json'),
    JSON.stringify(results, null, 2),
  );
}
async function controls() {
  return app.evaluate(() => {
    const state = (globalThis as unknown as { __DReview: Controls }).__DReview;
    return {
      counts: state.counts,
      pending: state.pending.map((p) => ({ channel: p.channel, key: p.key })),
    };
  });
}
async function hold(channel: string, key: string) {
  await app.evaluate(
    (_, rule) => {
      (globalThis as unknown as { __DReview: Controls }).__DReview.holds.push(
        rule,
      );
    },
    { channel, key },
  );
}
async function release() {
  await app.evaluate(() => {
    const state = (globalThis as unknown as { __DReview: Controls }).__DReview;
    state.holds = [];
    for (const entry of state.pending) entry.resolve();
    state.pending = [];
  });
  // IPC delivery barrier, without timers to hide races.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const raf = (
          globalThis as unknown as {
            requestAnimationFrame: (fn: () => void) => void;
          }
        ).requestAnimationFrame;
        raf(() => raf(resolve));
      }),
  );
}
async function fail(channel: string, key: string) {
  await app.evaluate(
    (_, rule) => {
      (globalThis as unknown as { __DReview: Controls }).__DReview.fail = rule;
    },
    { channel, key },
  );
}
async function clearFailure() {
  await app.evaluate(() => {
    (globalThis as unknown as { __DReview: Controls }).__DReview.fail = null;
  });
}
async function deferError(channel: string, key = '') {
  await app.evaluate(
    (_, rule) => {
      (
        globalThis as unknown as { __DReview: Controls }
      ).__DReview.deferredErrors.push(rule);
    },
    { channel, key },
  );
}
async function releaseOne(channel: string) {
  await app.evaluate((_, channel) => {
    const state = (globalThis as unknown as { __DReview: Controls }).__DReview;
    state.holds = state.holds.filter((rule) => rule.channel !== channel);
    const index = state.pending.findIndex((p) => p.channel === channel);
    const entry = state.pending.splice(index, 1)[0];
    if (!entry) throw Error('Entrega pendiente ausente');
    entry.resolve();
  }, channel);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const raf = (
          globalThis as unknown as {
            requestAnimationFrame: (f: () => void) => void;
          }
        ).requestAnimationFrame;
        raf(() => raf(resolve));
      }),
  );
}
async function openArchive() {
  await page.getByTestId('assistant-open').click();
  const archive = page.getByTestId('assistant-archive');
  if ((await archive.getAttribute('open')) === null)
    await archive.locator(':scope > summary').click();
  await expect(page.getByTestId('archive-conversation')).toHaveCount(20);
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  root = mkdtempSync(join(tmpdir(), 'cybersoc-evidence-'));
  mkdirSync(join(root, 'user-data'));
  dbPath = join(root, 'user-data/cybersoc.db');
  buildSyntheticProfile(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA foreign_keys=ON; UPDATE scan_jobs SET target_path='C:\\Sintetico\\' || id; UPDATE scan_jobs SET status='FAILED' WHERE id='history-00043'; UPDATE scan_jobs SET status='SCANNING' WHERE id='history-00044'; BEGIN",
  );
  const conversation = db.prepare(
    'INSERT INTO ai_conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)',
  );
  const message = db.prepare(
    'INSERT INTO ai_messages(id,conversation_id,role,content,tool_calls_json,model,created_at) VALUES(?,?,?,?,?,?,?)',
  );
  for (let n = 0; n < 45; n++) {
    const date = `2026-11-05T00:${String(n).padStart(2, '0')}:00.000Z`;
    conversation.run(chatId(n), title(n), date, date);
    const turns = n === 44 ? 60 : 2;
    for (let turn = 0; turn < turns; turn++) {
      message.run(
        randomUUID(),
        chatId(n),
        'user',
        `${title(n)} pregunta ${turn}`,
        null,
        null,
        date,
      );
      if (n === 44 && turn === 59)
        message.run(
          randomUUID(),
          chatId(n),
          'tool',
          'SECRETO_TOOL',
          JSON.stringify([{ name: 'list_scans', ok: true }]),
          null,
          date,
        );
      const id = randomUUID();
      message.run(
        id,
        chatId(n),
        'assistant',
        `${title(n)} respuesta ${turn} <b id="d-injected">literal</b>`,
        null,
        'fake-seeded',
        date,
      );
      if (n === 44 && turn === 59) {
        const card = {
          schema: 'cybersoc.assistant-card/v1',
          focus: { kind: 'NONE', id: null, label: null },
          references: [{ type: 'result', id: 'synthetic-3' }],
          suggestedActions: [
            { action: 'QUARANTINE', targetId: 'synthetic-3' },
            { action: 'RUN_SCAN_PLAN', targetId: null },
            {
              action: 'EXPORT_REPORT',
              targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          ],
          report: {
            reportDraftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            total: 90,
            verdicts: [{ verdict: 'DETECTED', count: 20 }],
            executiveSummary: 'Resumen sintético',
            conclusions: ['CONCLUSION_ARCHIVADA <img src=x>'],
            citedResultIds: [],
            label: 'Generado por IA',
          },
          scanPlan: {
            schema: 'cybersoc.scan-plan/v1',
            targets: [
              { zoneId: 'DESCARGAS', driveId: null, paths: ['C:\\Sintetico'] },
            ],
            profile: {
              layers: ['HASH', 'SIGNATURES'],
              includeHidden: false,
              maxFileSizeMB: 100,
            },
            rationale: 'Plan antiguo',
            layerRationale: [{ layer: 'HASH', why: 'RAZON_ARCHIVADA' }],
          },
        };
        const json = JSON.stringify(card);
        db.prepare('INSERT INTO ai_message_cards VALUES(?,?,?,?,?,?,?)').run(
          id,
          card.schema,
          'STORED',
          json,
          null,
          Buffer.byteLength(json),
          date,
        );
      }
    }
  }
  db.exec('COMMIT');
  db.close();
  mkdirSync(join(root, 'benigno'));
  for (let n = 0; n < 16; n++)
    writeFileSync(
      join(root, 'benigno', `nota-${n}.txt`),
      `Texto benigno ${n}\n`,
    );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => v[1] !== undefined,
    ),
  );
  for (const key of [
    'CYBERSOC_ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY',
    'CYBERSOC_RUN_AI_LIVE',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'CYBERSOC_ENGINE_CMD',
  ])
    delete env[key];
  Object.assign(env, {
    CYBERSOC_EVIDENCE_MODE: '1',
    CYBERSOC_EVIDENCE_LIVE: '0',
    CYBERSOC_EVIDENCE_ROOT: root,
    CYBERSOC_EVIDENCE_REPLIES: '100',
    PYTHONPATH: resolve(appRoot, '../engine/src'),
    PYTHONDONTWRITEBYTECODE: '1',
  });
  // Same local warm-up as the existing harness: do not prolong the handshake.
  execFileSync(
    join(appRoot, '../engine/.venv/Scripts/python.exe'),
    ['-c', 'import cybersoc_engine'],
    { env, windowsHide: true, stdio: 'pipe' },
  );
  app = await _electron.launch({
    executablePath: require('electron') as string,
    args: [appRoot],
    cwd: appRoot,
    env,
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('nav-home')).toBeVisible();
  const runtime = await app.evaluate(({ app, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw Error('Ventana ausente');
    w.setTitle('CyberSOC - correcciones D sintéticas');
    w.unmaximize();
    w.setSize(1024, 768);
    return { userData: app.getPath('userData'), versions: process.versions };
  });
  expect(resolve(runtime.userData)).toBe(resolve(root, 'user-data'));
  record('aislamiento', {
    root,
    dbPath,
    runtime,
    fakeProvider: true,
    realSQLite: true,
    realElectron: true,
  });
});
test.afterAll(async () => {
  await app?.close();
});

test('E-02: COMPLETED updates Home without navigating again', async () => {
  await page.getByTestId('nav-status').click();
  await expect(page.getByTestId('engine-status')).toContainText(
    'Motor: conectado',
  );
  await app.evaluate(
    (_, path) => {
      process.env.CYBERSOC_EVIDENCE_DIALOG_PATH = path;
      process.env.CYBERSOC_EVIDENCE_SCAN_DELAY_MS = '200';
    },
    join(root, 'benigno'),
  );
  await page.getByTestId('nav-scan').click();
  await page.getByTestId('scan-folder').click();
  await expect(page.getByTestId('job-status')).toContainText('Analizando');
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('dashboard-active')).toContainText('benigno');
  await expect(page.getByTestId('dashboard-last')).toContainText('benigno', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('dashboard-active')).not.toContainText(
    'benigno',
  );
  record('E02-real-scan', {
    last: await page.getByTestId('dashboard-last').innerText(),
    active: await page.getByTestId('dashboard-active').innerText(),
  });
  await page.screenshot({
    path: join(evidence, '07-dashboard-actualizado.png'),
  });
});

test('explicit latency/error instrumentation and test events', async () => {
  await app.evaluate(({ ipcMain }) => {
    const state: Controls = {
      counts: {},
      holds: [],
      pending: [],
      fail: null,
      deferredErrors: [],
      planPath: null,
      busyQuarantine: false,
    };
    (globalThis as unknown as { __DReview: Controls }).__DReview = state;
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers;
    for (const channel of [
      'scan:getJob',
      'dashboard:getOverview',
      'scan:getResult',
      'scan:listJobsPage',
      'assistant:listConversationsPage',
      'assistant:listMessages',
      'assistant:openConversation',
      'assistant:ask',
      'assistant:reset',
      'quarantine:quarantine',
      'scan:start',
      'reports:export',
    ]) {
      const original = handlers.get(channel);
      if (!original) throw Error('Handler ausente');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        state.counts[channel] = (state.counts[channel] ?? 0) + 1;
        const first = args[0];
        const query = first as
          | { conversationId?: string; offset?: number; message?: string }
          | undefined;
        const key =
          typeof first === 'string'
            ? first
            : String(
                query?.conversationId ?? query?.offset ?? query?.message ?? '',
              );
        const errorIndex = state.deferredErrors.findIndex(
          (rule) => rule.channel === channel && rule.key === key,
        );
        if (
          errorIndex >= 0 ||
          (channel === 'quarantine:quarantine' && state.busyQuarantine)
        ) {
          if (errorIndex >= 0) state.deferredErrors.splice(errorIndex, 1);
          if (channel === 'quarantine:quarantine') state.busyQuarantine = false;
          return new Promise((_, reject) =>
            state.pending.push({
              channel,
              key,
              resolve: () => reject(Error('Error diferido sintético')),
            }),
          );
        }
        if (state.fail?.channel === channel && state.fail.key === key)
          throw Error('Error sintético de entrega');
        const value = await original(event, ...args);
        if (channel === 'assistant:ask' && state.planPath) {
          return {
            ...(value as Record<string, unknown>),
            scanPlan: {
              schema: 'cybersoc.scan-plan/v1',
              targets: [
                { zoneId: 'DESCARGAS', driveId: null, paths: [state.planPath] },
              ],
              profile: {
                layers: ['HASH', 'SIGNATURES'],
                includeHidden: false,
                maxFileSizeMB: 100,
              },
              rationale: 'Plan de UI sintético, no ejecutar',
              layerRationale: [],
            },
            suggestedActions: [],
          };
        }
        if (state.holds.some((h) => h.channel === channel && h.key === key))
          return new Promise((resolve) =>
            state.pending.push({ channel, key, resolve: () => resolve(value) }),
          );
        return value;
      });
    }
  });
  record('dobles', {
    scope:
      'Solo latencia/error de entrega y eventos sintéticos desde aquí; handlers originales/SQLite reales. La prueba anterior no usa estos dobles.',
  });
});

test('E-01: three pages, selection kept, error/retry and archive without side effects', async () => {
  await openArchive();
  const before = await controls();
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(44) })
    .click();
  await expect(page.getByTestId('archive-message-count')).toContainText(
    '30 entradas visibles de 121',
  );
  const pages = [await page.getByTestId('archive-page-notice').innerText()];
  await page.getByTestId('archive-next').click();
  await expect(page.getByTestId('archive-page-notice')).toContainText(
    '21–40 de 47',
  );
  pages.push(await page.getByTestId('archive-page-notice').innerText());
  await expect(page.getByTestId('archive-messages')).toContainText(title(44));
  await fail('assistant:listConversationsPage', '40');
  await page.getByTestId('archive-next').click();
  await expect(page.getByTestId('archive-list-retry')).toBeVisible();
  await expect(page.getByTestId('archive-messages')).toContainText(title(44));
  await clearFailure();
  await page.getByTestId('archive-list-retry').click();
  await expect(page.getByTestId('archive-page-notice')).toContainText(
    '41–47 de 47',
  );
  pages.push(await page.getByTestId('archive-page-notice').innerText());
  await expect(page.getByTestId('archive-conversation')).toHaveCount(7);
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(0) })
    .click();
  await expect(page.getByTestId('archive-messages')).toContainText(
    `${title(0)} respuesta`,
  );
  await expect(page.getByTestId('archive-next')).toBeDisabled();
  await page.getByTestId('assistant-close').click();
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('archive-page-notice')).toContainText('41–47');
  await page.getByTestId('archive-prev').click();
  await expect(page.getByTestId('archive-conversation')).toHaveCount(20);
  await page.getByTestId('archive-prev').click();
  await expect(page.getByTestId('archive-conversation')).toHaveCount(20);
  const after = await controls();
  for (const channel of [
    'assistant:ask',
    'assistant:reset',
    'assistant:openConversation',
  ])
    expect(after.counts[channel] ?? 0).toBe(before.counts[channel] ?? 0);
  record('E01', { pages, before: before.counts, after: after.counts });
});

test('E-03: a slow or failed chat does not expose messages/continuation of another', async () => {
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(44) })
    .click();
  await expect(page.getByTestId('archive-messages')).toContainText(
    `${title(44)} respuesta`,
  );
  await hold('assistant:listMessages', chatId(43));
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(43) })
    .click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await expect(page.getByTestId('archive-continue')).toBeDisabled();
  await expect(page.getByTestId('archive-messages')).not.toContainText(
    `${title(44)} respuesta`,
  );
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(42) })
    .click();
  await expect(page.getByTestId('archive-messages')).toContainText(
    `${title(42)} respuesta`,
  );
  await release();
  await expect(page.getByTestId('archive-messages')).not.toContainText(
    `${title(43)} respuesta`,
  );
  await fail('assistant:listMessages', chatId(43));
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(43) })
    .click();
  await expect(page.getByTestId('archive-messages-retry')).toBeVisible();
  await expect(page.getByTestId('archive-continue')).toBeDisabled();
  await expect(page.getByTestId('archive-messages')).not.toContainText(
    `${title(42)} respuesta`,
  );
  await page.screenshot({ path: join(evidence, '08-error-chat-seguro.png') });
  await clearFailure();
  await page.getByTestId('archive-messages-retry').click();
  await expect(page.getByTestId('archive-messages')).toContainText(
    `${title(43)} respuesta`,
  );
  await page.getByTestId('archive-continue').click();
  await expect(page.getByTestId('copilot-reply').last()).toContainText(
    title(43),
  );
  record('E03', {
    continued: await page.getByTestId('copilot-reply').last().innerText(),
    staleDeliveryIgnored: true,
    errorDisablesContinue: true,
  });
});

test('E-06/08: full read-only card, tools and 121 entries', async () => {
  await page
    .getByTestId('archive-conversation')
    .filter({ hasText: title(44) })
    .click();
  await expect(page.getByTestId('archive-card-RECORDED')).toHaveCount(1);
  await page.getByTestId('archive-report').locator('summary').click();
  await expect(page.getByTestId('archive-report')).toContainText(
    'CONCLUSION_ARCHIVADA <img src=x>',
  );
  await page.getByTestId('archive-plan').locator('summary').click();
  await expect(page.getByTestId('archive-plan')).toContainText('C:\\Sintetico');
  await expect(page.getByTestId('archive-plan')).toContainText(
    'RAZON_ARCHIVADA',
  );
  await expect(page.getByTestId('archive-tools')).toContainText(
    'list_scans: correcta',
  );
  await expect(page.getByTestId('archive-messages')).not.toContainText(
    'SECRETO_TOOL',
  );
  await expect(page.locator('#d-injected')).toHaveCount(0);
  await expect(page.getByTestId('archive-report').locator('img')).toHaveCount(
    0,
  );
  await expect(
    page.locator('[data-action="RUN_SCAN_PLAN"],[data-action="EXPORT_REPORT"]'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('archive-conversation').filter({ hasText: title(44) }),
  ).toContainText('120 mensajes de usuario/asistente');
  const batches = [30];
  for (const count of [60, 90, 120, 121]) {
    await page.getByTestId('archive-older').click();
    await expect(page.getByTestId('archive-message-count')).toContainText(
      `${count} entradas visibles de 121`,
    );
    batches.push(count);
  }
  await page.getByTestId('archive-continue').click();
  await expect(page.getByTestId('assistant-notice')).toContainText(
    '10 de los últimos 10 turnos',
  );
  record('E06-E08', {
    batches,
    notice: await page.getByTestId('assistant-notice').innerText(),
    reportDetailsVisible: true,
    planReadOnly: true,
    toolHasNoArguments: true,
  });
  await page.screenshot({ path: join(evidence, '09-tarjeta-detalles.png') });
  await page.getByTestId('assistant-close').click();
});

test('E-04: late detail and reference do not change the last selection or focus', async () => {
  await page.getByTestId('nav-history').click();
  await expect(page.getByTestId('history-job')).toHaveCount(20);
  await hold('scan:getJob', 'history-00044');
  await page
    .getByTestId('history-job')
    .filter({ hasText: 'history-00044' })
    .click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await page
    .getByTestId('history-job')
    .filter({ hasText: 'history-00043' })
    .click();
  await expect(page.getByTestId('job-detail')).toContainText('history-00043');
  await release();
  await expect(page.getByTestId('job-detail')).toContainText('history-00043');
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('copilot-focus')).toContainText(
    'history-00043',
  );
  await page.getByTestId('assistant-close').click();
  await page.getByTestId('assistant-open').click();
  await hold('scan:getResult', 'synthetic-3');
  await page
    .getByTestId('archive-card-RECORDED')
    .locator('[data-reference-id="synthetic-3"]')
    .click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await page.getByTestId('assistant-close').click();
  await page
    .getByTestId('history-job')
    .filter({ hasText: 'history-00043' })
    .click();
  await expect(page.getByTestId('job-detail')).toContainText('history-00043');
  await release();
  await expect(page.getByTestId('job-detail')).toContainText('history-00043');
  // A request pending on exit cannot modify the global focus either.
  await hold('scan:getJob', 'history-00044');
  await page
    .getByTestId('history-job')
    .filter({ hasText: 'history-00044' })
    .click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await page.getByTestId('nav-home').click();
  await release();
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('copilot-focus')).toContainText(
    'history-00043',
  );
  await page.getByTestId('assistant-close').click();
  record('E04', {
    lastClicked: 'history-00043',
    lateDetailIgnored: true,
    lateReferenceIgnored: true,
    unmountedResponseIgnored: true,
  });
});

test('E-05, D02/D03: border contrast, keyboard and real 200% zoom', async () => {
  await page.getByTestId('dashboard-scope-ALL_COMPLETED').focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByTestId('dashboard-scope-ALL_COMPLETED'),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('dashboard-scope-RANGE')).toBeFocused();
  const colors = (await page
    .getByTestId('dashboard-scope-RANGE')
    .evaluate((element) => {
      const s = (
        globalThis as unknown as {
          getComputedStyle: (element: unknown) => {
            borderTopColor: string;
            backgroundColor: string;
            outlineColor: string;
            color: string;
          };
        }
      ).getComputedStyle(element);
      return {
        border: s.borderTopColor,
        background: s.backgroundColor,
        outline: s.outlineColor,
        text: s.color,
      };
    })) as {
    border: string;
    background: string;
    outline: string;
    text: string;
  };
  const luminance = (color: string) =>
    color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((n) => {
        const c = n / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  const contrast = (a: string, b: string) => {
    const l = [luminance(a), luminance(b)].sort((a, b) => b - a);
    return (l[0]! + 0.05) / (l[1]! + 0.05);
  };
  expect(contrast(colors.border, colors.background)).toBeGreaterThanOrEqual(3);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw Error('Ventana ausente');
    w.unmaximize();
    w.setSize(1024, 768);
    w.webContents.setZoomFactor(2);
  });
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('copilot-panel')).toHaveAttribute(
    'role',
    'dialog',
  );
  await expect(page.locator('.app-main')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('assistant-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('copilot-reset')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('assistant-close')).toBeFocused();
  await release();
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw Error('Ventana ausente');
    return {
      png: (await w.webContents.capturePage()).toPNG().toString('base64'),
      zoom: w.webContents.getZoomFactor(),
    };
  });
  expect(image.zoom).toBe(2);
  writeFileSync(
    join(evidence, '10-zoom200.png'),
    Buffer.from(image.png, 'base64'),
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('assistant-open')).toBeFocused();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw Error('Ventana ausente');
    w.webContents.setZoomFactor(1);
  });
  record('E05-D02-D03', {
    colors,
    borderContrast: contrast(colors.border, colors.background),
    textContrast: contrast(colors.text, colors.background),
    focusContrast: contrast(colors.outline, colors.background),
    zoom: 2,
    screenReaderTested: false,
  });
});

test('E-02: FAILED/CANCELLED events and updated result keep scope/range', async () => {
  await page.getByTestId('dashboard-from').fill('2026-11-02');
  await page.getByTestId('dashboard-to').fill('2026-11-04');
  await page.getByTestId('dashboard-apply-range').click();
  await expect(page.getByTestId('dashboard-scope-notice')).toContainText(
    'incompletas',
  );
  for (const status of ['FAILED', 'CANCELLED']) {
    const before = (await controls()).counts['dashboard:getOverview'] ?? 0;
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE scan_jobs SET status=? WHERE id=?').run(
        status,
        'history-00044',
      );
    } finally {
      db.close();
    }
    const job = await page.evaluate(() =>
      (globalThis as unknown as { cybersoc: CyberSocApi }).cybersoc.scan.getJob(
        'history-00044',
      ),
    );
    // Explicit synthetic event; data reread by the real Core/SQLite.
    await app.evaluate(
      ({ BrowserWindow }, job) =>
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          'scan:finished',
          job,
        ),
      job,
    );
    await expect
      .poll(async () => (await controls()).counts['dashboard:getOverview'] ?? 0)
      .toBeGreaterThan(before);
    await expect(page.getByTestId('dashboard-loading')).toBeHidden();
    await expect(page.getByTestId('dashboard-active')).toContainText(
      'No hay un análisis en curso',
    );
    await expect(page.getByTestId('dashboard-scope-notice')).not.toContainText(
      'incompletas',
    );
    await expect(page.getByTestId('dashboard-activity')).toContainText(
      'Del 2026-11-02 al 2026-11-04',
    );
  }
  await page.getByTestId('dashboard-scope-ALL_COMPLETED').click();
  const beforeRows = await page
    .getByTestId('dashboard-verdict-chart')
    .locator('tbody tr')
    .allTextContents();
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      "UPDATE scan_results SET verdict='SUSPICIOUS' WHERE id='synthetic-3'",
    ).run();
  } finally {
    db.close();
  }
  const before = (await controls()).counts['dashboard:getOverview'] ?? 0;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.send('ai:resultUpdated', {
      resultId: 'synthetic-3',
      aiStatus: 'COMPLETED',
    }),
  );
  await expect
    .poll(async () => (await controls()).counts['dashboard:getOverview'] ?? 0)
    .toBeGreaterThan(before);
  await expect(page.getByTestId('dashboard-loading')).toBeHidden();
  const afterRows = await page
    .getByTestId('dashboard-verdict-chart')
    .locator('tbody tr')
    .allTextContents();
  expect(afterRows).not.toEqual(beforeRows);
  await expect(
    page.getByTestId('dashboard-scope-ALL_COMPLETED'),
  ).toHaveAttribute('aria-pressed', 'true');
  record('E02-eventos-sinteticos', {
    statuses: ['FAILED', 'CANCELLED'],
    rangePreserved: true,
    beforeRows,
    afterRows,
    realSQLite: true,
    syntheticEvents: true,
  });
});

test('E-02: open history updates filter and detail on finish', async () => {
  await page.getByTestId('nav-history').click();
  await page.getByTestId('history-job-status').selectOption('CANCELLED');
  await page.getByTestId('history-apply-jobs').click();
  await expect(page.getByTestId('history-job')).toHaveCount(1);
  await page.getByTestId('history-job').click();
  await expect(page.getByTestId('job-detail')).toContainText('Cancelado');
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      "UPDATE scan_jobs SET status='COMPLETED' WHERE id='history-00044'",
    ).run();
  } finally {
    db.close();
  }
  const job = await page.evaluate(() =>
    (globalThis as unknown as { cybersoc: CyberSocApi }).cybersoc.scan.getJob(
      'history-00044',
    ),
  );
  await app.evaluate(
    ({ BrowserWindow }, job) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('scan:finished', job),
    job,
  );
  await expect(page.getByTestId('history-page-notice')).toHaveText(
    'No hay análisis guardados.',
  );
  await expect(page.getByTestId('job-detail')).toContainText('Completado');
  await expect(page.getByTestId('history-job-status')).toHaveValue('CANCELLED');
  const resultDb = new DatabaseSync(dbPath);
  let resultId: string;
  try {
    const row = resultDb
      .prepare(
        "SELECT id FROM scan_results WHERE job_id='history-00044' ORDER BY id LIMIT 1",
      )
      .get();
    if (!row || typeof row.id !== 'string')
      throw Error('Resultado sintético ausente');
    resultId = row.id;
    resultDb
      .prepare("UPDATE scan_results SET verdict='SUSPICIOUS' WHERE id=?")
      .run(resultId);
  } finally {
    resultDb.close();
  }
  await app.evaluate(
    ({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('ai:resultUpdated', {
        resultId: id,
        aiStatus: 'COMPLETED',
      }),
    resultId,
  );
  await expect(
    page.locator(`[data-testid="result-row"][data-result-id="${resultId}"]`),
  ).toContainText('Sospechoso');
  record('E02-historial', {
    filterPreserved: true,
    jobDetail: 'COMPLETED',
    filteredCount: 0,
    syntheticEvent: true,
    resultUpdated: resultId,
  });
});

test('E-09: Escape/Cancel/reopen actions at wide, narrow and 200 %', async () => {
  await page.getByTestId('assistant-open').click();
  const before = (await controls()).counts;
  const matrix = [];
  for (const [width, zoom] of [
    [1024, 1],
    [520, 1],
    [1024, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (!w) throw Error('Sin ventana');
        w.unmaximize();
        w.setSize(size.width!, 768);
        w.webContents.setZoomFactor(size.zoom!);
      },
      { width, zoom },
    );
    const trigger = page
      .getByTestId('archive-card-RECORDED')
      .locator('[data-action="QUARANTINE"]');
    for (const cancel of ['Escape', 'Cancelar', 'Escape']) {
      await trigger.click();
      await expect(page.getByTestId('copilot-action-dialog')).toBeVisible();
      await expect(page.getByTestId('copilot-action-cancel')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('copilot-action-confirm')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(page.getByTestId('copilot-action-cancel')).toBeFocused();
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await page.getByTestId('copilot-action-cancel').click();
      await expect(page.getByTestId('copilot-action-dialog')).toHaveCount(0);
      await expect(page.locator('dialog:modal')).toHaveCount(0);
      await expect(page.getByTestId('copilot-panel')).toBeVisible();
      await expect(trigger).toBeFocused();
    }
    matrix.push({ width, zoom, cancelAndReopen: true, noOrphanModal: true });
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw Error('Sin ventana');
    w.webContents.setZoomFactor(1);
    w.setSize(1024, 768);
  });
  const after = (await controls()).counts;
  for (const key of ['quarantine:quarantine', 'scan:start', 'reports:export'])
    expect(after[key] ?? 0).toBe(before[key] ?? 0);
  await page
    .getByTestId('archive-messages')
    .screenshot({ path: join(evidence, '11-modal-recuperado.png') });
  record('E09-acciones', { matrix, noExecution: true, before, after });
});

test('E-09: live plan cancels and reopens without starting a scan; busy operation keeps the lock', async () => {
  await app.evaluate(
    (_, path) => {
      (globalThis as unknown as { __DReview: Controls }).__DReview.planPath =
        path;
    },
    join(root, 'benigno'),
  );
  await page.getByTestId('copilot-reset').click();
  await expect(page.getByTestId('copilot-message')).toBeEditable();
  await page
    .getByTestId('copilot-message')
    .fill('Consulta sintética para tarjeta de UI');
  await page.getByTestId('copilot-send').click();
  await expect(page.getByTestId('copilot-plan')).toBeVisible();
  const before = (await controls()).counts['scan:start'] ?? 0;
  for (const [width, zoom] of [
    [1024, 1],
    [520, 1],
    [1024, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (!w) throw Error('Sin ventana');
        w.setSize(size.width!, 768);
        w.webContents.setZoomFactor(size.zoom!);
      },
      { width, zoom },
    );
    for (const cancel of ['Escape', 'Cancelar']) {
      await page.getByTestId('copilot-plan-execute').click();
      await expect(page.getByTestId('copilot-plan-dialog')).toBeVisible();
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await page.getByTestId('copilot-plan-cancel').click();
      await expect(page.getByTestId('copilot-plan-dialog')).toHaveCount(0);
      await expect(page.locator('dialog:modal')).toHaveCount(0);
      await expect(page.getByTestId('copilot-plan-execute')).toBeFocused();
      await expect(page.getByTestId('copilot-panel')).toBeVisible();
    }
  }
  expect((await controls()).counts['scan:start'] ?? 0).toBe(before);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) throw Error('Sin ventana');
    w.webContents.setZoomFactor(1);
    w.setSize(1024, 768);
    (globalThis as unknown as { __DReview: Controls }).__DReview.planPath =
      null;
  });
  await app.evaluate(() => {
    (
      globalThis as unknown as { __DReview: Controls }
    ).__DReview.busyQuarantine = true;
  });
  const trigger = page
    .getByTestId('archive-card-RECORDED')
    .locator('[data-action="QUARANTINE"]');
  await trigger.click();
  await page.getByTestId('copilot-action-confirm').click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await expect(page.getByTestId('copilot-action-cancel')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('copilot-action-dialog')).toBeVisible();
  await releaseOne('quarantine:quarantine');
  await expect(page.getByTestId('copilot-action-cancel')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('copilot-action-dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  record('E09-plan-y-busy', {
    planCardMock: true,
    realScanStarted: false,
    busyOperationMock: true,
    cannotCancelBusy: true,
    errorThenEscapeCloses: true,
  });
});

test('E-10: an old failed reset does not delete a continued chat or new response/card', async () => {
  await deferError('assistant:reset');
  await page.getByTestId('copilot-reset').click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await expect(page.getByTestId('copilot-message')).toBeDisabled();
  await expect(page.getByTestId('copilot-loading')).toHaveText(
    'Preparando nueva conversación…',
  );
  await page.getByTestId('archive-continue').click();
  await expect(page.getByTestId('copilot-reply').last()).toContainText(
    title(44),
  );
  const continued = await page.getByTestId('copilot-reply').allTextContents();
  await releaseOne('assistant:reset');
  expect(await page.getByTestId('copilot-reply').allTextContents()).toEqual(
    continued,
  );
  await deferError('assistant:reset');
  await page.getByTestId('copilot-reset').click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await page.getByTestId('copilot-reset').click();
  await expect(page.getByTestId('copilot-message')).toBeEditable();
  await app.evaluate(
    (_, path) => {
      (globalThis as unknown as { __DReview: Controls }).__DReview.planPath =
        path;
    },
    join(root, 'benigno'),
  );
  await page
    .getByTestId('copilot-message')
    .fill('Respuesta de la nueva conversación');
  await page.getByTestId('copilot-send').click();
  await expect(page.getByTestId('copilot-plan')).toBeVisible();
  const newReply = await page.getByTestId('copilot-reply').allTextContents();
  await releaseOne('assistant:reset');
  expect(await page.getByTestId('copilot-reply').allTextContents()).toEqual(
    newReply,
  );
  await expect(page.getByTestId('copilot-plan')).toHaveCount(1);
  await app.evaluate(() => {
    (globalThis as unknown as { __DReview: Controls }).__DReview.planPath =
      null;
  });
  record('E10-rechazos-antiguos', {
    continuedPreserved: true,
    newReplyAndCardPreserved: true,
    resetErrorDeliveryMock: true,
  });
});

test('E-10: an old successful reset does not enable sending while another chat continues', async () => {
  await hold('assistant:reset', '');
  await page.getByTestId('copilot-reset').click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await hold('assistant:openConversation', chatId(44));
  await page.getByTestId('archive-continue').click();
  await expect.poll(async () => (await controls()).pending.length).toBe(2);
  await releaseOne('assistant:reset');
  await expect(page.getByTestId('copilot-message')).toBeDisabled();
  await expect(page.getByTestId('copilot-loading')).toHaveText(
    'Cargando conversación…',
  );
  await releaseOne('assistant:openConversation');
  await expect(page.getByTestId('copilot-message')).toBeEditable();
  const counts = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM ai_conversations) c,(SELECT COUNT(*) FROM ai_messages) m,(SELECT COUNT(*) FROM ai_message_cards) cards',
        )
        .get();
    } finally {
      db.close();
    }
  };
  const before = counts();
  await deferError('assistant:reset');
  await page.getByTestId('copilot-reset').click();
  await expect.poll(async () => (await controls()).pending.length).toBe(1);
  await releaseOne('assistant:reset');
  await expect(page.getByTestId('copilot-reply')).toContainText(
    'No se pudo reiniciar',
  );
  await expect(page.getByTestId('copilot-message')).toBeDisabled();
  await expect(page.getByTestId('copilot-suggestion').first()).toBeDisabled();
  await fail('assistant:openConversation', chatId(44));
  await page.getByTestId('archive-continue').click();
  await expect(page.getByTestId('assistant-notice')).toContainText(
    'No se pudo continuar',
  );
  await expect(page.getByTestId('copilot-message')).toBeDisabled();
  await clearFailure();
  await page.getByTestId('archive-continue').click();
  await expect(page.getByTestId('copilot-message')).toBeEditable();
  await page.getByTestId('copilot-reset').click();
  await expect(page.getByTestId('copilot-message')).toBeEditable();
  await expect(page.getByTestId('copilot-reply')).toHaveCount(0);
  expect(counts()).toEqual(before);
  record('E10-transiciones', {
    oldSuccessDoesNotUnlockNewTransition: true,
    currentErrorBlocksOldContextUntilRecovery: true,
    failedContinueKeepsBlockAndSuccessfulContinueRecovers: true,
    sqliteBefore: before,
    sqliteAfter: counts(),
    deliveryMocks: true,
  });
});

test('E-09: result confirmation uses the same cancellation and can be reopened', async () => {
  await page
    .getByTestId('archive-card-RECORDED')
    .locator('[data-reference-id="synthetic-3"]')
    .click();
  await page.getByTestId('assistant-close').click();
  const trigger = page.getByTestId('quarantine-file');
  await expect(trigger).toBeVisible();
  const before = (await controls()).counts['quarantine:quarantine'] ?? 0;
  for (let i = 0; i < 2; i++) {
    await trigger.click();
    await expect(page.getByTestId('quarantine-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quarantine-dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect((await controls()).counts['quarantine:quarantine'] ?? 0).toBe(before);
  record('E09-resultado', { escapeAndReopen: true, noQuarantineCalled: true });
});

test('R-UI-01: background revalidation keeps notice, rows and page while the response arrives', async () => {
  await page.getByTestId('nav-history').click();
  await page.getByTestId('history-job-status').selectOption('');
  await page.getByTestId('history-apply-jobs').click();
  await expect(page.getByTestId('history-job')).toHaveCount(20);
  await page.getByTestId('history-next').click();
  await expect(page.getByTestId('history-page-notice')).toContainText('21–40');
  const before = await page.getByTestId('history-page-notice').innerText();
  const rows = await page.getByTestId('history-job').allTextContents();
  await hold('scan:listJobsPage', '20');
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ai:resultUpdated', {
        resultId: 'synthetic-3',
        aiStatus: 'COMPLETED',
      });
    });
    await expect
      .poll(async () =>
        (await controls()).pending.some(
          (request) =>
            request.channel === 'scan:listJobsPage' && request.key === '20',
        ),
      )
      .toBe(true);
    await expect(page.getByTestId('history-page-notice')).toHaveText(before);
    expect(await page.getByTestId('history-job').allTextContents()).toEqual(
      rows,
    );
  } finally {
    await release();
  }
  await expect(page.getByTestId('history-page-notice')).toHaveText(before);
  record('RUI01-background', {
    before,
    rowsPreserved: true,
    deliveryHeld: true,
  });
});

test('E-01: empty archive does not keep chats from an earlier page', async () => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; DELETE FROM ai_conversations');
  } finally {
    db.close();
  }
  await page.getByTestId('assistant-open').click();
  const archive = page.getByTestId('assistant-archive');
  if ((await archive.getAttribute('open')) !== null)
    await archive.locator(':scope > summary').click();
  await archive.locator(':scope > summary').click();
  await expect(page.getByTestId('archive-page-notice')).toHaveText(
    'No hay conversaciones guardadas.',
  );
  await expect(page.getByTestId('archive-conversation')).toHaveCount(0);
  await expect(page.getByTestId('archive-messages')).toHaveCount(0);
  await expect(page.getByTestId('archive-next')).toBeDisabled();
  record('E01-vacio', { realSQLite: true, listCount: 0 });
});

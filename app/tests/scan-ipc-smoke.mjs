// Run after npm run build. Uses the real sandboxed renderer, preload, IPC and SQLite;
// only the engine process is a controlled test fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'cybersoc-ipc-smoke-'));
const fixtures = join(directory, 'archivos ñ');
mkdirSync(fixtures);
writeFileSync(join(fixtures, 'á.txt'), 'abc');
writeFileSync(join(fixtures, 'b.txt'), 'abc');
const env = {
  ...process.env,
  CYBERSOC_ENGINE_CMD: JSON.stringify([
    process.execPath,
    join(appRoot, 'tests', 'fixtures', 'ipc-smoke-engine.mjs'),
  ]),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  process.execPath,
  [
    join(appRoot, 'node_modules', 'electron', 'cli.js'),
    '.',
    '--inspect=0',
    `--user-data-dir=${join(directory, 'profile')}`,
  ],
  {
    cwd: appRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
let exited = false;
let socket;
let evaluate;
const pending = new Map();
const exit = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => {
    exited = true;
    resolveExit(code);
  });
});
const capture = (data) => {
  output = (output + data.toString()).slice(-20_000);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);
const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const deadline = Date.now() + 45_000;
async function until(predicate) {
  while (!(await predicate())) {
    if (exited || Date.now() >= deadline)
      throw new Error(`Electron smoke timeout: ${output}`);
    await delay(50);
  }
}
function killTree() {
  if (exited) return;
  if (process.platform === 'win32')
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else child.kill();
}

try {
  let endpoint;
  await until(() => {
    endpoint = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+/)?.[0];
    return endpoint;
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error || message.result?.exceptionDetails)
      request.reject(new Error(JSON.stringify(message)));
    else request.resolve(message.result?.result?.value);
  });
  let sequence = 0;
  evaluate = (expression) =>
    new Promise((resolveValue, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Inspector timeout'));
      }, 15_000);
      pending.set(id, { resolve: resolveValue, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => { const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'); return eval(${JSON.stringify(expression)}); })()`,
            returnByValue: true,
            awaitPromise: true,
          },
        }),
      );
    });
  await until(() =>
    evaluate(
      "(() => { try { return require('electron/main').BrowserWindow.getAllWindows().some(w => w.isVisible() && !w.webContents.isLoading()); } catch { return false; } })()",
    ),
  );
  const renderer = (code) =>
    evaluate(
      `require('electron/main').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(code)})`,
    );
  await until(
    async () =>
      (await renderer('window.cybersoc.system.getStatus()')).engine.status ===
      'connected',
  );
  const boundary = await renderer(
    `({ require: typeof require, process: typeof process, namespaces: Object.keys(window.cybersoc).sort(), scan: Object.keys(window.cybersoc.scan).sort() })`,
  );
  assert.equal(boundary.require, 'undefined');
  assert.equal(boundary.process, 'undefined');
  assert.deepEqual(boundary.namespaces, ['dialog', 'scan', 'system']);
  assert.deepEqual(boundary.scan, [
    'cancel',
    'getJob',
    'listJobs',
    'listResults',
    'onFinished',
    'onProgress',
    'start',
  ]);
  await renderer(`(() => {
    window.__ipcSmoke = { progress: [], finished: [] };
    window.__ipcSmoke.offProgress = window.cybersoc.scan.onProgress(p => window.__ipcSmoke.progress.push(p));
    window.__ipcSmoke.offFinished = window.cybersoc.scan.onFinished(j => window.__ipcSmoke.finished.push(j));
    return true;
  })()`);
  const { jobId } = await renderer(
    `window.cybersoc.scan.start(${JSON.stringify({ kind: 'FOLDER', path: fixtures })})`,
  );
  await until(() =>
    renderer('window.__ipcSmoke.progress.some(p => Boolean(p.currentPath))'),
  );
  await renderer(`window.cybersoc.scan.cancel(${JSON.stringify(jobId)})`);
  const result = await renderer(`(async () => ({
    job: await window.cybersoc.scan.getJob(${JSON.stringify(jobId)}),
    page: await window.cybersoc.scan.listResults({ jobId: ${JSON.stringify(jobId)}, offset: 0, limit: 200 }),
    history: await window.cybersoc.scan.listJobs(20),
    finished: window.__ipcSmoke.finished,
  }))()`);
  assert.equal(result.job.status, 'CANCELLED');
  assert.equal(result.job.filesProcessed, 1);
  assert.equal(result.page.total, 1);
  assert.equal(result.page.items.length, 1);
  assert.equal(result.page.items[0].verdict, 'NOT_EVALUATED');
  assert.equal(result.finished.length, 1);
  assert.equal(result.history[0].id, jobId);
  const unsubscribeCounts = await renderer(
    '(() => { window.__ipcSmoke.offProgress(); window.__ipcSmoke.offFinished(); return [window.__ipcSmoke.progress.length, window.__ipcSmoke.finished.length]; })()',
  );
  const next = await renderer(
    `window.cybersoc.scan.start(${JSON.stringify({ kind: 'FILE', path: join(fixtures, 'á.txt') })})`,
  );
  await until(
    async () =>
      (
        await renderer(
          `window.cybersoc.scan.getJob(${JSON.stringify(next.jobId)})`,
        )
      ).status === 'COMPLETED',
  );
  assert.deepEqual(
    await renderer(
      '[window.__ipcSmoke.progress.length, window.__ipcSmoke.finished.length]',
    ),
    unsubscribeCounts,
  );
  const unchanged = await renderer(
    `window.cybersoc.scan.listResults({ jobId: ${JSON.stringify(jobId)}, offset: 0, limit: 200 })`,
  );
  assert.deepEqual(unchanged, result.page);
  console.info(
    JSON.stringify(
      {
        boundary,
        cancelled: result.job.status,
        results: result.page.total,
        next: 'COMPLETED',
        unsubscribe: 'passed',
        engine: 'test fixture',
        ipcSmoke: 'passed',
      },
      null,
      2,
    ),
  );
} finally {
  if (evaluate && !exited) {
    try {
      await evaluate(
        "setImmediate(() => require('electron/main').app.quit()); true",
      );
    } catch {
      /* The process may already be exiting after a startup failure. */
    }
  }
  socket?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  const timer = setTimeout(killTree, 10_000);
  try {
    assert.equal(await exit, 0, output);
  } finally {
    clearTimeout(timer);
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
    assert.ok(resolved.includes('cybersoc-ipc-smoke-'));
    rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

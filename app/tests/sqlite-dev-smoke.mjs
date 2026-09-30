import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Ejecutar mediante npm run test:sqlite:dev');
const directory = mkdtempSync(join(tmpdir(), 'cybersoc-sqlite-dev-'));
const profile = join(directory, 'perfil con tilde á');

async function startAndInspect() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    process.execPath,
    [npmCli, 'run', 'dev', '--', '--inspect=0', `--user-data-dir=${profile}`],
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
  let electronPid;
  const terminate = () => {
    if (exited) return;
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      if (electronPid) process.kill(electronPid);
      child.kill();
    }
  };
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      exited = true;
      resolveExit(code);
    });
  });
  const capture = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const deadline = Date.now() + 45_000;
  const delay = () =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  try {
    let endpoint;
    while (
      !(endpoint = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+/)?.[0])
    ) {
      if (exited || Date.now() > deadline)
        throw new Error(`No se inicio Electron: ${output}`);
      await delay();
    }
    socket = new WebSocket(endpoint);
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const reply = JSON.parse(data);
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.error || reply.result?.exceptionDetails)
        request.reject(new Error(JSON.stringify(reply)));
      else request.resolve(reply.result?.result?.value);
    });
    const evaluate = (expression) =>
      new Promise((resolveValue, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Inspector timeout'));
        }, 5_000);
        pending.set(id, { resolve: resolveValue, reject, timer });
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => { const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json'); return eval(${JSON.stringify(expression)}); })()`,
              returnByValue: true,
            },
          }),
        );
      });
    try {
      // The inspector can connect before Electron installs its module loader.
      while (
        !(await evaluate(
          "(() => { try { return Boolean(require('electron/main').app?.isReady()); } catch { return false; } })()",
        ))
      ) {
        if (exited || Date.now() > deadline)
          throw new Error(`No se cargo main: ${output}`);
        await delay();
      }
      electronPid = await evaluate('process.pid');
      while (
        !(await evaluate(
          "require('electron/main').BrowserWindow.getAllWindows().some(w => w.isVisible() && !w.webContents.isLoading())",
        ))
      ) {
        if (exited || Date.now() > deadline)
          throw new Error(`No se abrio la ventana: ${output}`);
        await delay();
      }
      return await evaluate(`(() => {
      const { app, BrowserWindow } = require('electron/main');
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = require('node:path').join(app.getPath('userData'), 'cybersoc.db');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return {
          electron: process.versions.electron, node: process.versions.node,
          sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
          path: dbPath, visible: BrowserWindow.getAllWindows().some(w => w.isVisible()),
          history: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
          tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
          journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
        };
      } finally { db.close(); }
    })()`);
    } catch (error) {
      console.error('Fallo del smoke:', error, output);
      throw error;
    } finally {
      // Close through the real application lifecycle, including engine and database cleanup.
      try {
        await evaluate(
          "setImmediate(() => require('electron/main').app.quit()); true",
        );
      } finally {
        socket.close();
      }
      const timer = setTimeout(terminate, 10_000);
      try {
        assert.equal(await exit, 0, output);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    socket?.close();
    if (!exited) {
      terminate();
      await exit;
    }
  }
}

try {
  const first = await startAndInspect();
  const second = await startAndInspect();
  for (const result of [first, second]) {
    assert.equal(result.path, join(profile, 'cybersoc.db'));
    assert.equal(result.visible, true);
    assert.equal(result.journal, 'wal');
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].version, 1);
    assert.deepEqual(
      result.tables.map(({ name }) => name),
      ['schema_migrations', 'settings'],
    );
  }
  assert.deepEqual(
    second.history,
    first.history,
    'Un reinicio no debe cambiar applied_at ni reaplicar 001',
  );
  console.info(JSON.stringify({ first, second, ca05: 'passed' }, null, 2));
} finally {
  const resolved = resolve(directory);
  assert.ok(
    resolved.startsWith(
      resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'),
    ),
  );
  assert.ok(resolved.includes('cybersoc-sqlite-dev-'));
  rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron, chromium } from 'playwright';

// Recovered from the Codex T6.2 draft (base 6d9394d), without modifying its source.

const appRoot = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const packaged = args[0] === '--exe';
assert(
  args[0] === '--dev' || (packaged && args[1]),
  'Uso: smoke.mjs --dev | --exe <ruta> [captura.png]',
);
const root = mkdtempSync(
  join(process.env.PUBLIC, 'cybersoc-evidence-package-'),
);
const fixtures = join(root, 'fixtures');
const python = packaged
  ? join(resolve(args[1], '..'), 'resources/runtime/python.exe')
  : join(appRoot, '../engine/.venv/Scripts/python.exe');
execFileSync(
  python,
  [
    '-B',
    '-c',
    [
      'import runpy,shutil,sys',
      'g=runpy.run_path(sys.argv[1])',
      'with g["generate_fixtures"](include_filetype=True,include_signatures=True,include_rules=True,include_heuristics=True) as source:',
      ' shutil.copytree(source,sys.argv[2])',
    ].join('\n'),
    join(appRoot, '../engine/tests/fixtures/generate.py'),
    fixtures,
  ],
  { windowsHide: true },
);
console.log('SMOKE_MODE', packaged ? 'packaged' : 'npm run dev');
console.log('SMOKE_ROOT', root);
const env = {
  ...process.env,
  CYBERSOC_EVIDENCE_MODE: '1',
  CYBERSOC_EVIDENCE_LIVE: '0',
  CYBERSOC_EVIDENCE_ROOT: root,
  CYBERSOC_EVIDENCE_DIALOG_PATH: fixtures,
  CYBERSOC_EVIDENCE_REPLIES: '0',
  PYTHONDONTWRITEBYTECODE: '1',
};
for (const key of Object.keys(env)) {
  if (
    /^(PYTHON|VIRTUAL_ENV|CONDA|CYBERSOC_ENGINE_CMD|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL)/i.test(
      key,
    ) ||
    /API_KEY|TOKEN|SECRET/i.test(key)
  )
    delete env[key];
}
if (packaged) {
  for (const key of Object.keys(env))
    if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [
    join(process.env.SystemRoot, 'System32'),
    process.env.SystemRoot,
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'),
  ].join(';');
  console.log('PATH_WITHOUT_DEV_TOOLS', env.PATH);
  // Negative controls: the package must ignore a foreign engine and Python.
  env.CYBERSOC_ENGINE_CMD = '["C:/cybersoc-no-existe/python.exe"]';
  env.PYTHONHOME = 'C:/cybersoc-no-existe';
  env.PYTHONPATH = 'C:/cybersoc-no-existe';
  for (const tool of ['node', 'npm', 'python', 'uv']) {
    assert.throws(
      () =>
        execFileSync(
          join(process.env.SystemRoot, 'System32/where.exe'),
          [tool],
          {
            env,
            windowsHide: true,
            stdio: 'pipe',
          },
        ),
      `Una herramienta de desarrollo sigue en PATH: ${tool}`,
    );
  }
  console.log(
    'NO_DEV_TOOLS_IN_PATH node npm python uv; comandos ajenos de motor/Python configurados como control negativo.',
  );
} else env.PYTHONPATH = resolve(appRoot, '../engine/src');
let electron, browser, child, page;
async function until(fn, name) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(200);
  }
  throw Error('Timeout: ' + name);
}
try {
  if (packaged) {
    electron = await _electron.launch({
      executablePath: resolve(args[1]),
      cwd: root,
      env,
      timeout: 30000,
    });
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    page = await electron.firstWindow();
  } else {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolveClose) => server.close(resolveClose));
    child = spawn(
      join(
        process.env.SystemRoot,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& npm.cmd run dev -- --remote-debugging-port=' + port,
      ],
      {
        cwd: appRoot,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (b) => process.stdout.write(b));
    child.stderr.on('data', (b) => process.stderr.write(b));
    await until(async () => {
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {
          timeout: 1000,
        });
        return true;
      } catch {
        assert(child.exitCode === null, 'npm run dev terminó antes de abrir');
        return false;
      }
    }, 'npm run dev');
    page = browser.contexts()[0].pages()[0];
  }
  page.setDefaultTimeout(20000);
  await until(
    async () =>
      page
        .evaluate(
          async () =>
            (await window.cybersoc.system.getStatus()).engine.status ===
            'connected',
        )
        .catch(() => false),
    'motor conectado',
  );
  console.log(
    'ENGINE_STATUS',
    JSON.stringify(
      await page.evaluate(() => window.cybersoc.system.getStatus()),
    ),
  );
  await page.getByTestId('scan-folder').click();
  await until(
    async () =>
      (
        await page
          .getByTestId('job-status')
          .textContent()
          .catch(() => '')
      )?.includes('Completado'),
    'escaneo finalizado',
  );
  const jobs = await page.evaluate(() => window.cybersoc.scan.listJobs());
  const job = jobs.find((j) => j.targetPath === fixtures);
  assert(job && job.status === 'COMPLETED');
  const results = await page.evaluate(
    (jobId) =>
      window.cybersoc.scan.listResults({ jobId, offset: 0, limit: 200 }),
    job.id,
  );
  assert.equal(results.items.length, 40);
  assert.equal(job.filesProcessed, 40);
  const signatures = results.items.filter((r) =>
    /^CSD-TEST-\d{3}\.txt$/.test(r.fileName),
  );
  assert.equal(signatures.length, 5);
  assert(signatures.every((r) => r.verdict === 'DETECTED'));
  // AUTO may disable SCRIPTS depending on the zone; no fixed verdict is invented.
  assert(
    results.items.some(
      (r) => r.fileName === 'encoded_marker.ps1' && r.status === 'SCANNED',
    ),
  );
  console.log(
    'SCAN_OK',
    JSON.stringify({
      files: results.items.length,
      processed: job.filesProcessed,
      errors: job.filesError,
      signaturesDetected: signatures.length,
      // Dictionary: one key per verdict; each sum O(1) average,
      // full walk O(n). It counts results, not unique files.
      verdicts: results.items.reduce((a, r) => {
        a[r.verdict] = (a[r.verdict] ?? 0) + 1;
        return a;
      }, {}),
    }),
  );
  const pid = JSON.parse(
    readFileSync(join(root, 'engine-pid.json'), 'utf8'),
  ).pid;
  assert(Number.isSafeInteger(pid));
  const actual = execFileSync(
    join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process -Id ' + pid + ').Path',
    ],
    { windowsHide: true, encoding: 'utf8' },
  ).trim();
  assert.equal(actual.toLowerCase(), resolve(python).toLowerCase());
  console.log('ENGINE_EXECUTABLE', actual);
  await page
    .getByTestId('result-row')
    .filter({ hasText: 'CSD-TEST-001.txt' })
    .first()
    .click();
  await page.getByTestId('result-summary').waitFor();
  assert(
    (await page.getByTestId('result-summary').innerText()).includes(
      'Detectado',
    ),
  );
  if (packaged && args[2]) {
    await electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1120, 820);
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: resolve(args[2]),
      fullPage: false,
      animations: 'disabled',
    });
    console.log('SCREENSHOT', resolve(args[2]));
  }
  console.log(
    'SMOKE_PASS: motor real conectado; 40 fixtures; cinco firmas detectadas; sin API real.',
  );
} finally {
  if (electron) await electron.close();
  else if (page) await page.close();
  if (browser) await browser.close();
  if (child && child.exitCode === null)
    await Promise.race([once(child, 'exit'), delay(10000)]);
}

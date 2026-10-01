import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright';

// Ejecuta el código histórico sin cambiar sus veredictos ni insertar resultados.
// Uso: node scripts/evidence/capture-s1-history.mjs <checkout-S1> <evidencias-S1>
assert.equal(process.argv.length, 4);
const checkout = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: checkout,
  encoding: 'utf8',
}).trim();
assert.equal(revision, '0263d98635f5a9e8cdb33a5293312216ce1cefe9');
assert.equal(
  execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: checkout,
    encoding: 'utf8',
  }).trim(),
  '',
);
assert(
  existsSync(join(checkout, 'app/out/main/index.cjs')),
  'Compilar primero la app histórica',
);
const root = mkdtempSync(join(tmpdir(), 'cybersoc-s1-history-'));
const userData = join(root, 'user-data');
const fixtures = join(root, 'fixtures');
const bulk = join(root, '5000');
mkdirSync(userData);
mkdirSync(bulk);
mkdirSync(destination, { recursive: true });
const python = join(checkout, 'engine/.venv/Scripts/python.exe');
const env = {
  ...process.env,
  PYTHONPATH: join(checkout, 'engine/src'),
  PYTHONDONTWRITEBYTECODE: '1',
};
delete env.CYBERSOC_ANTHROPIC_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
delete env.CYBERSOC_EVIDENCE_MODE;
env.CYBERSOC_ENGINE_CMD = JSON.stringify([python, '-m', 'cybersoc_engine']);
execFileSync(
  python,
  [
    '-B',
    '-c',
    'import runpy,shutil,sys\ng=runpy.run_path(sys.argv[1])\nwith g["generate_fixtures"]() as root: shutil.copytree(root,sys.argv[2])',
    join(checkout, 'engine/tests/fixtures/generate.py'),
    fixtures,
  ],
  { env, windowsHide: true },
);
for (let i = 0; i < 5000; i++)
  writeFileSync(join(bulk, `documento-${i}.txt`), `Texto inofensivo ${i}.\n`);
// Solo el arranque del arnés fija userData; el bundle histórico permanece intacto.
const bootstrap = join(root, 'bootstrap.cjs');
writeFileSync(
  bootstrap,
  `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(userData)});\nrequire(${JSON.stringify(join(checkout, 'app/out/main/index.cjs'))});\n`,
);
let electron;
try {
  electron = await _electron.launch({
    args: [bootstrap],
    cwd: join(checkout, 'app'),
    env,
  });
  const page = await electron.firstWindow();
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1360, 1000),
  );
  assert.equal(
    await electron.evaluate(({ app }) => app.getPath('userData')),
    userData,
  );
  await page.getByRole('button', { name: 'Estado', exact: true }).click();
  await page.getByText(/Motor: conectado/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Escaneo', exact: true }).click();
  async function scan(path) {
    // Sustituye únicamente la elección del diálogo nativo, nunca el escaneo.
    await electron.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, path);
    await page
      .getByRole('button', { name: 'Escanear carpeta', exact: true })
      .click();
    await page.getByText(`Carpeta: ${path}`, { exact: true }).waitFor();
    await page
      .getByText('Estado: Completado', { exact: true })
      .waitFor({ timeout: 180000 });
  }
  await scan(fixtures);
  await page
    .getByRole('cell', { name: 'Sin evaluar', exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole('cell', { name: 'Sin evaluar', exact: true }).count(),
    25,
  );
  assert.equal(
    await page.getByRole('cell', { name: 'Limpio', exact: true }).count(),
    0,
  );
  const image = join(destination, '08-tabla-resultados.png');
  if (existsSync(image))
    copyFileSync(image, join(destination, '08-tabla-resultados-s2.png'));
  await page.screenshot({ path: image, fullPage: true });
  const db = new DatabaseSync(join(userData, 'cybersoc.db'), {
    readOnly: true,
  });
  const rows = db.prepare('SELECT * FROM scan_results ORDER BY seq').all();
  assert.equal(rows.length, 25);
  for (const row of rows) {
    assert.equal(row.verdict, 'NOT_EVALUATED');
    assert.equal(
      row.sha256,
      createHash('sha256').update(readFileSync(row.path)).digest('hex'),
    );
  }
  // Observa la actividad del renderer durante 5000 archivos; no altera la UI.
  await page.evaluate(() => {
    window.__captureTiming = {
      running: true,
      frames: 0,
      maxGapMs: 0,
      previous: performance.now(),
      progress: [],
    };
    const sample = (now) => {
      const t = window.__captureTiming;
      t.frames++;
      t.maxGapMs = Math.max(t.maxGapMs, now - t.previous);
      t.previous = now;
      if (t.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__stopCaptureProgress = window.cybersoc.scan.onProgress((event) =>
      window.__captureTiming.progress.push({
        at: performance.now(),
        processed: event.processed,
      }),
    );
  });
  const started = performance.now();
  await scan(bulk);
  const durationMs = performance.now() - started;
  const timing = await page.evaluate(() => {
    window.__captureTiming.running = false;
    window.__stopCaptureProgress();
    return window.__captureTiming;
  });
  await delay(100);
  const bulkJob = db
    .prepare('SELECT * FROM scan_jobs WHERE target_path = ?')
    .get(bulk);
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM scan_results WHERE job_id = ?')
    .get(bulkJob.id).n;
  assert.equal(count, 5000);
  assert.equal(bulkJob.files_processed, 5000);
  assert.equal(bulkJob.status, 'COMPLETED');
  assert(timing.frames > 10, 'El renderer debe seguir pintando');
  await page.screenshot({ path: join(destination, '09-perf-ui-5000.png') });
  const first = rows[0];
  const certutil = execFileSync(
    'certutil',
    ['-hashfile', first.path, 'SHA256'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert(certutil.includes(first.sha256));
  writeFileSync(
    join(destination, '02-certutil-hash.txt'),
    `Código S1: ${revision}\nSHA-256 SQLite: ${first.sha256}\n${certutil}\nCoincidencia: PASS\n`,
  );
  const sql = {
    revision,
    database: join(userData, 'cybersoc.db'),
    jobs: db.prepare('SELECT * FROM scan_jobs').all(),
    fixtureResults: rows,
    bulkResultCount: count,
  };
  writeFileSync(
    join(destination, '04-consulta-sql.txt'),
    'SELECT * FROM scan_jobs; SELECT * FROM scan_results WHERE job_id=<fixtures>; COUNT(*) del trabajo de 5000.\n' +
      JSON.stringify(sql, null, 2) +
      '\n',
  );
  db.close();
  const record = {
    revision,
    temporaryRoot: root,
    fixtures: 25,
    verdict: 'NOT_EVALUATED',
    generated: [
      '08-tabla-resultados.png',
      '09-perf-ui-5000.png',
      '02-certutil-hash.txt',
      '04-consulta-sql.txt',
    ],
    ui5000: {
      durationMs,
      filesPerSecond: 5000 / (durationMs / 1000),
      frames: timing.frames,
      maxFrameGapMs: timing.maxGapMs,
      progressEvents: timing.progress.length,
      metrics: JSON.parse(bulkJob.metrics_json),
    },
    completed: true,
  };
  writeFileSync(
    join(destination, 'capture-s1-historical.json'),
    JSON.stringify(record, null, 2) + '\n',
  );
  console.log(JSON.stringify(record, null, 2));
} finally {
  await electron?.close();
}

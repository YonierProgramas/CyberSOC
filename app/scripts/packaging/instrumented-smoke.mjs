import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from 'playwright';

const require = createRequire(import.meta.url);
const appRoot = resolve(import.meta.dirname, '../..');
const evidence = resolve(process.argv[2]);
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'cybersoc-evidence-s11-á espacios-'));
const fixtures = join(root, 'benigno');
mkdirSync(fixtures);
writeFileSync(
  join(fixtures, 'nota con á.txt'),
  'Texto benigno offline de S11.\n',
);
const bootstrap = join(appRoot, 'out/instrumentation/bootstrap.cjs');
writeFileSync(
  bootstrap,
  `require('electron').app.setAppPath(${JSON.stringify(appRoot)});require('./main/index.cjs');`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/API_KEY|TOKEN|SECRET|ELECTRON_RUN_AS_NODE|CYBERSOC_RUN.*LIVE/i.test(key))
    delete env[key];
Object.assign(env, {
  CYBERSOC_EVIDENCE_MODE: '1',
  CYBERSOC_EVIDENCE_LIVE: '0',
  CYBERSOC_EVIDENCE_ROOT: root,
  CYBERSOC_EVIDENCE_DIALOG_PATH: fixtures,
  PYTHONPATH: resolve(appRoot, '../engine/src'),
  PYTHONDONTWRITEBYTECODE: '1',
});
const results = [];
let app;
try {
  app = await _electron.launch({
    executablePath: require('electron'),
    args: [bootstrap],
    env,
    cwd: appRoot,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.getByTestId('nav-home').waitFor();
  assert.equal(await page.getByTestId('copilot-panel').isVisible(), false);
  results.push('dashboard y asistente cerrado');
  await page.getByTestId('nav-status').click();
  await page
    .getByTestId('engine-status')
    .filter({ hasText: 'Motor: conectado' })
    .waitFor({ timeout: 20_000 });
  results.push('motor real conectado');
  await page.getByTestId('nav-scan').click();
  await page.getByTestId('scan-folder').click();
  await page
    .getByTestId('job-status')
    .filter({ hasText: 'Completado' })
    .waitFor({ timeout: 30_000 });
  results.push('escaneo benigno real sin proveedor IA');
  await page.getByTestId('nav-history').click();
  await page.screenshot({
    path: join(evidence, 'instrumentado-historial.png'),
  });
  await page.getByTestId('assistant-open').click();
  await page.screenshot({
    path: join(evidence, 'instrumentado-asistente.png'),
  });
  results.push('historial y chat consultables');
  await app.close();
  app = null;
  const db = new DatabaseSync(join(root, 'user-data/cybersoc.db'), {
    readOnly: true,
  });
  const counts = db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM scan_jobs) jobs, (SELECT COUNT(*) FROM scan_results) results',
    )
    .get();
  assert.equal(counts.jobs, 1);
  assert.equal(counts.results, 1);
  db.close();
  writeFileSync(
    join(evidence, 'instrumented-results.json'),
    JSON.stringify(
      { kind: 'INSTRUMENTADO, NO RELEASE', root, results, counts },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ results, counts }));
} finally {
  if (app) await app.close();
}

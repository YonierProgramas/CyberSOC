import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  _electron,
  type ElectronApplication,
  type Page,
  type Video,
} from 'playwright';
import { z } from 'zod';

const appRoot = resolve(import.meta.dirname, '..');
const engineRoot = resolve(appRoot, '../engine');
const python = join(
  engineRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const args = process.argv.slice(2);
const sprintIndex = args.indexOf('--sprint');
const sprint = args[sprintIndex + 1];
const live = args.includes('--live');
if (
  sprintIndex < 0 ||
  !['01', '02', '03', '04'].includes(sprint) ||
  args.some(
    (arg, index) =>
      index !== sprintIndex + 1 && !['--sprint', '--live'].includes(arg),
  )
) {
  throw new Error(
    'Uso: npm run evidence:capture -- --sprint <01|02|03|04> [--live]',
  );
}
if (live && !process.env.CYBERSOC_ANTHROPIC_API_KEY) {
  throw new Error(
    '--live requiere CYBERSOC_ANTHROPIC_API_KEY en el entorno. No la pegues en el guion.',
  );
}

function findDocumentation(): string {
  let candidate = appRoot;
  while (dirname(candidate) !== candidate) {
    if (existsSync(join(candidate, 'construccion/sprints')))
      return join(candidate, 'construccion');
    candidate = dirname(candidate);
  }
  throw new Error('No se encontró construccion/sprints junto al repositorio.');
}

const destination = join(
  findDocumentation(),
  'sprints',
  sprint === '01'
    ? 'sprint-01-escaneo-real'
    : sprint === '02'
      ? 'sprint-02-evidencia-ia-v1'
      : sprint === '03'
        ? 'sprint-03-motor-hibrido-ia-v2'
        : 'sprint-04-cuarentena-copilot-v1',
  'evidencias',
);
mkdirSync(destination, { recursive: true });
const evidenceParent =
  sprint === '03' || sprint === '04'
    ? (process.env.PUBLIC ?? join('C:\\Users', 'Public'))
    : tmpdir();
const root = mkdtempSync(join(evidenceParent, 'cybersoc-evidence-'));
const generated: string[] = [];
const limitations: string[] = [];
const checks: string[] = [];
const stepSchema = z.strictObject({
  accion: z.enum([
    'cancelar_3000',
    'bloquear',
    'reiniciar',
    'matar_motor',
    'escanear',
    'seleccionar',
    'capturar',
    'configurar',
    'esperar',
    'perfil',
    'cuarentena',
    'abrir_cuarentena',
    'restaurar',
    'restaurar_otra',
    'eliminar',
    'copilot',
    'copilot_offline',
    'guardar_video',
    'consultar',
  ]),
  selector: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  archivo: z
    .string()
    .regex(/^[a-zA-Z0-9-]+\.(png|mp4|txt)$/)
    .optional(),
  parametros: z
    .strictObject({
      ruta: z.string().optional(),
      tipo: z.enum(['FILE', 'FOLDER']).optional(),
      texto: z.string().optional(),
      modo: z.enum(['AUTO', 'CUSTOM']).optional(),
      capas: z.string().optional(),
    })
    .optional(),
});
const steps = z
  .array(stepSchema)
  .min(1)
  .parse(
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, 'evidence', `sprint-${sprint}.json`),
        'utf8',
      ),
    ),
  );
let electron: ElectronApplication | undefined;
let page: Page;
let video: Video | null = null;
let lock: ChildProcess | undefined;

function environment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (!live) delete env.CYBERSOC_ANTHROPIC_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  // No heredar un motor de prueba de otra tarea ni su configuración de usuario.
  delete env.CYBERSOC_ENGINE_CMD;
  return {
    ...env,
    CYBERSOC_EVIDENCE_MODE: '1',
    CYBERSOC_EVIDENCE_LIVE: live ? '1' : '0',
    CYBERSOC_EVIDENCE_ROOT: root,
    CYBERSOC_EVIDENCE_SCAN_DELAY_MS: '0',
    CYBERSOC_EVIDENCE_DIALOG_PATH: '',
    ...(sprint === '03'
      ? {
          CYBERSOC_EVIDENCE_SCENARIO: 'escalation',
          CYBERSOC_EVIDENCE_RULES: '1',
        }
      : {}),
    ...(sprint === '04' ? { CYBERSOC_EVIDENCE_REPLIES: '8' } : {}),
    PYTHONPATH: join(engineRoot, 'src'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

async function until(
  condition: () => Promise<boolean>,
  description: string,
  timeout = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(100);
  }
  throw new Error(`Tiempo agotado: ${description}.`);
}

async function launch(record = false): Promise<void> {
  const options = {
    args: [appRoot],
    cwd: appRoot,
    env: environment(),
    timeout: 30_000,
  };
  try {
    electron = await _electron.launch({
      ...options,
      ...(record
        ? {
            recordVideo: {
              dir: join(root, 'video'),
              size: { width: 1680, height: 1000 },
            },
          }
        : {}),
    });
  } catch (error) {
    if (!record) throw error;
    limitations.push(
      `recordVideo no pudo iniciar en Electron: ${safeMessage(error)}. Se usan 01a/01b/01c.`,
    );
    electron = await _electron.launch(options);
  }
  page = await electron.firstWindow();
  page.setDefaultTimeout(15_000);
  const consoleNotes: string[] = [];
  page.on('console', (message) => {
    if (consoleNotes.length < 8)
      consoleNotes.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    if (consoleNotes.length < 8)
      consoleNotes.push(`pageerror: ${error.message}`);
  });
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1680, 1000),
  );
  const opened = await page
    .getByTestId('nav-status')
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    if (record) {
      limitations.push(
        'recordVideo dejó la ventana sin la interfaz. Se usan 01a/01b/01c.',
      );
      await electron.close();
      electron = undefined;
      video = null;
      await launch(false);
      return;
    }
    const url = page.url();
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    throw new Error(
      `La interfaz no apareció. url=${url} body=${body.slice(0, 400)} console=${consoleNotes.join(' | ')}`,
    );
  }
  video = record ? page.video() : null;
  await page.getByTestId('nav-status').click();
  await until(
    async () =>
      (await page.getByTestId('engine-status').innerText()).includes(
        'Motor: conectado',
      ),
    'conexión del motor',
  );
  await page.getByTestId('nav-scan').click();
  const actual = await electron.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(
    actual,
    join(root, 'user-data'),
    'La BD debe estar aislada en el temporal',
  );
}

async function configurePath(path: string, milliseconds = 0): Promise<void> {
  assert(electron);
  const target = resolve(root, path);
  const inside = relative(root, target);
  assert(
    inside && !inside.startsWith('..') && !isAbsolute(inside),
    'Solo fixtures temporales',
  );
  assert(existsSync(target), 'El fixture debe existir');
  await electron.evaluate(
    (_api, values) => {
      process.env.CYBERSOC_EVIDENCE_DIALOG_PATH = values.target;
      process.env.CYBERSOC_EVIDENCE_SCAN_DELAY_MS = String(values.milliseconds);
    },
    { target, milliseconds },
  );
}

function systemFolder(): string {
  const systemRoot = process.env.SystemRoot;
  assert(systemRoot, 'SystemRoot debe existir en Windows');
  const folder = join(systemRoot, 'System32', 'drivers', 'etc');
  assert(existsSync(folder), 'La subcarpeta de System32 debe existir');
  const inside = relative(join(systemRoot, 'System32'), folder);
  assert(
    inside && !inside.startsWith('..') && !isAbsolute(inside),
    'Solo una subcarpeta de System32',
  );
  return folder;
}

async function configureAbsolute(target: string): Promise<void> {
  assert(electron);
  await electron.evaluate((_api, value) => {
    process.env.CYBERSOC_EVIDENCE_DIALOG_PATH = value;
    process.env.CYBERSOC_EVIDENCE_SCAN_DELAY_MS = '0';
  }, target);
}

async function scan(
  path: string,
  kind: 'FILE' | 'FOLDER',
  milliseconds = 0,
  finish = true,
): Promise<void> {
  const external = path === 'sistema' ? systemFolder() : null;
  await page.getByTestId('nav-scan').click();
  if (external) await configureAbsolute(external);
  else await configurePath(path, milliseconds);
  await page.getByTestId(kind === 'FILE' ? 'scan-file' : 'scan-folder').click();
  await page.getByTestId('job-status').waitFor();
  await until(
    async () =>
      (await page.getByTestId('job-detail').innerText()).includes(
        external ?? resolve(root, path),
      ),
    'nuevo trabajo con la ruta solicitada',
  );
  if (finish) await completed();
}

async function waitForText(selector: string, text: string): Promise<void> {
  await until(
    async () => {
      const locator = page.getByTestId(selector);
      if ((await locator.count()) === 0) return false;
      return (await locator.innerText({ timeout: 2_000 })).includes(text);
    },
    `${selector} contiene ${text}`,
    120_000,
  );
}

async function profile(
  mode: 'AUTO' | 'CUSTOM',
  layers?: string,
): Promise<void> {
  await page.getByTestId('nav-scan').click();
  await page
    .getByTestId(mode === 'AUTO' ? 'profile-mode-auto' : 'profile-mode-custom')
    .check();
  if (mode !== 'CUSTOM' || !layers) return;
  const keep = new Set(layers.split(',').map((item) => item.trim()));
  for (const layer of ['FILETYPE', 'RULES', 'HEURISTICS', 'PE', 'SCRIPTS']) {
    const box = page.getByTestId(`layer-${layer}`);
    if (keep.has(layer)) await box.check();
    else await box.uncheck();
  }
}

async function completed(): Promise<void> {
  await until(
    async () =>
      (await page.getByTestId('job-status').innerText()).includes('Completado'),
    'trabajo completado',
    live ? 180_000 : 60_000,
  );
}

async function capture(
  file: string,
  selector?: string,
  fullPage = false,
): Promise<void> {
  assert.equal(basename(file), file);
  const path = join(destination, file);
  if (selector) {
    const element = page.getByTestId(selector);
    await element.scrollIntoViewIfNeeded();
    await element.screenshot({ path, animations: 'disabled' });
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path, fullPage, animations: 'disabled' });
  }
  generated.push(file);
  console.log(`Captura: ${file}`);
}

function query(sql: string): Record<string, unknown>[] {
  const database = new DatabaseSync(join(root, 'user-data/cybersoc.db'), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

async function cancellation(file: string): Promise<void> {
  await scan('cancelacion', 'FOLDER', 6, false);
  await until(
    async () =>
      Number(await page.getByTestId('processed-count').innerText()) >= 1300,
    'mitad de los 3000 fixtures',
    180_000,
  );
  await configurePath('cancelacion', 4000);
  await delay(200); // Permite entrar en la próxima lectura ralentizada del motor real.
  await capture('01a-progreso.png');
  await page.getByTestId('cancel-scan').click();
  await until(
    async () =>
      (await page.getByTestId('job-status').innerText()).includes('Cancelando'),
    'estado Cancelando',
  );
  await capture('01b-cancelando.png');
  await until(
    async () =>
      (await page.getByTestId('job-status').innerText()).includes('Cancelado'),
    'estado Cancelado',
  );
  await capture('01c-cancelado.png');
  const rows = query(
    'SELECT files_processed AS processed, status FROM scan_jobs ORDER BY rowid DESC LIMIT 1',
  );
  assert.equal(rows[0].status, 'CANCELLED');
  assert(Number(rows[0].processed) >= 1300 && Number(rows[0].processed) < 3000);
  checks.push(
    `Cancelación real: ${rows[0].processed}/3000 procesados, CANCELLED.`,
  );
  const recording = video;
  await electron!.close();
  electron = undefined;
  if (recording) {
    const webm = join(root, 'cancelacion.webm');
    await recording.saveAs(webm);
    const mp4 = join(root, file);
    const env = environment();
    delete env.CYBERSOC_ANTHROPIC_API_KEY;
    try {
      if (process.platform === 'win32') {
        // Media Foundation ya viene con Windows: no se añade un paquete conversor.
        execFileSync(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-File',
            join(import.meta.dirname, 'evidence/transcode-video.ps1'),
            '-SourcePath',
            webm,
            '-DestinationPath',
            mp4,
          ],
          { env, windowsHide: true, timeout: 75_000, stdio: 'pipe' },
        );
      } else
        execFileSync(
          'ffmpeg',
          ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4],
          { env, windowsHide: true, timeout: 60_000, stdio: 'pipe' },
        );
      assert.equal(readFileSync(mp4).subarray(4, 8).toString(), 'ftyp');
      copyFileSync(mp4, join(destination, file));
      generated.push(file);
      checks.push(
        'recordVideo de Playwright convertido a MP4 real, contenedor ftyp verificado.',
      );
    } catch {
      // Nunca se cambia la extensión WebM a MP4: sería una evidencia inválida.
      await recording.saveAs(
        join(destination, '01-video-escaneo-cancelacion.webm'),
      );
      generated.push('01-video-escaneo-cancelacion.webm');
      limitations.push(
        `${file}: el conversor de video del sistema no pudo producir MP4; se entregan WebM y 01a/01b/01c.`,
      );
    }
  } else if (!limitations.some((item) => item.includes('recordVideo'))) {
    limitations.push(
      `${file}: Electron no proporcionó un objeto Video; se entregan 01a/01b/01c.`,
    );
  }
  await launch();
}

async function lockedFile(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    limitations.push(`${file}: FileShare.None requiere Windows.`);
    return;
  }
  const env = environment();
  delete env.CYBERSOC_ANTHROPIC_API_KEY;
  lock = spawn(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(import.meta.dirname, 'evidence/lock-fixture.ps1'),
      '-FixturePath',
      join(root, 'bloqueado.txt'),
    ],
    { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let ready = false;
  lock.stdout!.on('data', (data: Buffer) => {
    if (data.toString().includes('LOCK_READY')) ready = true;
  });
  try {
    await until(async () => ready, 'FileShare.None adquirido', 10_000);
    await scan('bloqueado.txt', 'FILE');
    assert.equal(
      query(
        'SELECT error_code AS code FROM scan_results ORDER BY rowid DESC LIMIT 1',
      )[0].code,
      'FILE_LOCKED',
    );
    await page
      .getByTestId('result-row')
      .filter({ hasText: 'bloqueado.txt' })
      .waitFor();
    if (
      !(await page.getByTestId('results-panel').innerText()).includes(
        'FILE_LOCKED',
      )
    ) {
      limitations.push(
        `${file}: FILE_LOCKED está confirmado en SQLite, pero la UI solo muestra Error. Mostrar el código requiere ampliar el alcance del renderer.`,
      );
    }
    await capture(file);
    checks.push('FILE_LOCKED persistido durante FileShare.None real.');
  } finally {
    const child = lock;
    child.stdin!.end('\n');
    await Promise.race([once(child, 'exit'), delay(5000)]);
    if (child.exitCode === null) child.kill();
    lock = undefined;
  }
}

async function restart(file: string): Promise<void> {
  const before = query('SELECT id FROM scan_jobs ORDER BY rowid');
  await electron!.close();
  electron = undefined;
  await launch();
  assert.deepEqual(query('SELECT id FROM scan_jobs ORDER BY rowid'), before);
  await page.getByTestId('nav-history').click();
  await page.getByTestId('history-job').first().waitFor();
  await page.getByTestId('history-job').first().click();
  await page.getByTestId('job-detail').waitFor();
  await capture(file);
  checks.push(
    `Reinicio conserva los ${before.length} trabajos de la misma BD temporal.`,
  );
}

async function crash(file: string): Promise<void> {
  await scan('caida', 'FOLDER', 250, false);
  await until(
    async () =>
      Number(await page.getByTestId('processed-count').innerText()) >= 3,
    'escaneo activo antes de matar el motor',
  );
  const pidRecord = z
    .strictObject({
      pid: z.number().int().positive(),
      parentPid: z.number().int().positive(),
    })
    .parse(JSON.parse(readFileSync(join(root, 'engine-pid.json'), 'utf8')));
  assert.equal(
    pidRecord.parentPid,
    await electron!.evaluate(() => process.pid),
    'Solo el motor hijo de esta instancia',
  );
  assert.notEqual(pidRecord.pid, process.pid);
  if (process.platform === 'win32') {
    // El launcher de un venv puede tener su propio hijo Python. Solo este árbol,
    // cuyo padre Electron acabamos de verificar, pertenece a la demostración.
    execFileSync('taskkill.exe', ['/PID', String(pidRecord.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
      stdio: 'pipe',
    });
  } else process.kill(pidRecord.pid);
  await until(
    async () =>
      query("SELECT id FROM scan_results WHERE error_code = 'ENGINE_CRASHED'")
        .length > 0,
    'ENGINE_CRASHED persistido',
  );
  await until(
    async () =>
      Number(await page.getByTestId('processed-count').innerText()) >= 10,
    'continuación después del reinicio del motor',
  );
  await page
    .getByTestId('result-row')
    .filter({ hasText: 'Error' })
    .first()
    .waitFor();
  if (
    !(await page.getByTestId('results-panel').innerText()).includes(
      'ENGINE_CRASHED',
    )
  ) {
    limitations.push(
      `${file}: ENGINE_CRASHED está confirmado en SQLite, pero la UI solo muestra Error. Mostrar el código requiere ampliar el alcance del renderer.`,
    );
  }
  await capture(file, undefined, true);
  await completed();
  const row = query(
    'SELECT status, metrics_json AS metrics FROM scan_jobs ORDER BY rowid DESC LIMIT 1',
  )[0];
  assert.equal(row.status, 'COMPLETED');
  assert(JSON.parse(String(row.metrics)).engineRestarts >= 1);
  checks.push('ENGINE_CRASHED real; motor reiniciado y trabajo COMPLETED.');
}

async function select(text: string): Promise<void> {
  if (sprint === '04' && (await page.getByTestId('result-row').count()) === 0) {
    await page.getByTestId('nav-history').click();
    await page
      .getByTestId('history-job')
      .filter({ hasText: 'fixtures' })
      .first()
      .click();
    await page.getByTestId('result-row').first().waitFor();
  }
  const rows = page.getByTestId('result-row').filter({ hasText: text });
  const row =
    (await rows.count()) <= 1
      ? rows
      : page.getByTestId('result-row').filter({
          has: page.getByRole('cell', { name: text, exact: true }),
        });
  await row.first().click();
  await until(
    async () =>
      (await page.getByTestId('result-summary').innerText()).includes(text),
    'detalle del fixture seleccionado',
  );
  if (sprint !== '04' && text === 'CSD-TEST-001.txt') {
    await until(
      async () =>
        (await page.getByTestId('ai-analysis').innerText()).includes('Resumen'),
      'análisis válido persistido',
      live ? 180_000 : 30_000,
    );
    assert(
      (await page.getByTestId('result-summary').innerText()).includes(
        'Detectado',
      ),
    );
    const analyses = query(
      "SELECT validation_status AS validation, model FROM ai_analyses WHERE validation_status = 'VALID'",
    );
    assert(analyses.length > 0);
    checks.push(
      `Análisis VALID; DETECTED conservado; proveedor ${live ? 'Claude' : 'FakeAIProvider'}.`,
    );
  } else if (text === 'factura.pdf.ps1') {
    const content = await page.getByTestId('evidence-panel').innerText();
    assert(
      content.includes('DOUBLE_EXTENSION') && content.includes('TYPE_MISMATCH'),
    );
    checks.push(
      'TYPE_MISMATCH y DOUBLE_EXTENSION visibles en el mismo fixture inofensivo.',
    );
  }
}

async function settings(file: string): Promise<void> {
  await page.getByTestId('nav-settings').click();
  if (!live) {
    // Credencial ficticia; sirve para demostrar safeStorage sin exponer una real.
    await page.getByTestId('api-key-input').fill('evidence-fixture-1234');
    await page.getByTestId('save-api-key').click();
  }
  await until(
    async () =>
      (await page.getByTestId('ai-settings').innerText()).includes(
        'Configurada ••••',
      ),
    'clave enmascarada',
  );
  assert.equal(await page.getByTestId('api-key-input').inputValue(), '');
  await capture(file);
  checks.push('Configuración muestra solo ••••last4; input vacío al capturar.');
}

function fixtureName(value: string): string {
  assert(/^[\w.-]+$/.test(value), 'Nombre de fixture no permitido');
  return value;
}

function quarantineRows(fileName: string) {
  return page.getByTestId('quarantine-row').filter({ hasText: fileName });
}

async function quarantineItems(fileName: string) {
  return query(
    'SELECT status, original_path AS path FROM quarantine_items',
  ).filter((row) => String(row.path).endsWith(fileName));
}

async function quarantineFile(fileName: string): Promise<void> {
  await page.getByTestId('quarantine-file').click();
  if (
    sprint === '04' &&
    !video &&
    !existsSync(join(destination, '01a-detectado.png'))
  ) {
    await capture('01a-detectado.png', 'quarantine-dialog');
  }
  await page.getByTestId('quarantine-confirm').click();
  await until(async () => {
    const items = await quarantineItems(fileName);
    return items.some((item) => item.status === 'QUARANTINED');
  }, `cuarentena de ${fileName}`);
  await until(
    async () => (await page.getByTestId('quarantine-dialog').count()) === 0,
    'diálogo de cuarentena cerrado',
  );
}

async function openQuarantine(fileName: string): Promise<void> {
  await page.getByTestId('nav-quarantine').click();
  await until(
    async () => (await quarantineRows(fileName).count()) > 0,
    `fila de cuarentena de ${fileName}`,
  );
  if (
    sprint === '04' &&
    !video &&
    !existsSync(join(destination, '01b-cuarentena.png'))
  ) {
    await capture('01b-cuarentena.png');
  }
}

async function restoreQuarantine(fileName: string): Promise<void> {
  const row = quarantineRows(fileName);
  await row.getByTestId('quarantine-restore').click();
  await page.getByTestId('quarantine-restore-confirm').click();
  await page.getByTestId('quarantine-restore-detected-confirm').click();
  await until(
    async () => (await row.innerText()).includes('Restaurado'),
    `restauración de ${fileName}`,
  );
  if (
    sprint === '04' &&
    !video &&
    !existsSync(join(destination, '01c-restaurado.png'))
  ) {
    await capture('01c-restaurado.png');
  }
}

async function restoreWithoutOverwrite(
  fileName: string,
  shot: string,
): Promise<void> {
  const item = (await quarantineItems(fileName)).find(
    (row) => row.status === 'QUARANTINED',
  );
  assert(item, 'Debe haber un archivo en cuarentena para restaurar');
  const original = String(item.path);
  writeFileSync(
    original,
    'Archivo inocuo ya presente en la ruta original.\n',
    'utf8',
  );
  const row = quarantineRows(fileName);
  await row.getByTestId('quarantine-restore').click();
  await page.getByTestId('quarantine-original-exists').check();
  const alternate = join(root, `copia-${fileName}`);
  await page.getByTestId('quarantine-target-path').fill(alternate);
  await capture(shot, 'quarantine-restore-dialog');
  await page.getByTestId('quarantine-restore-confirm').click();
  await page.getByTestId('quarantine-restore-detected-confirm').click();
  await until(
    async () => (await row.innerText()).includes('Restaurado'),
    `restauración sin sobrescribir ${fileName}`,
  );
  assert(readFileSync(original, 'utf8').includes('ya presente'));
  assert(existsSync(alternate));
  checks.push(
    'La ruta original no se sobrescribió; la copia salió a otra ruta.',
  );
}

async function deleteQuarantine(fileName: string, shot: string): Promise<void> {
  const row = quarantineRows(fileName);
  await row.getByTestId('quarantine-delete').click();
  await page.getByTestId('quarantine-delete-phrase').fill('ELIMINAR');
  await capture(shot, 'quarantine-delete-dialog');
  await page.getByTestId('quarantine-delete-confirm').click();
  await until(async () => {
    const items = await quarantineItems(fileName);
    return items.some((item) => item.status === 'DELETED');
  }, `eliminación de ${fileName}`);
}

async function askCopilot(question: string, shot: string): Promise<void> {
  await page
    .getByTestId('copilot-suggestion')
    .filter({ hasText: question })
    .click();
  await until(async () => {
    const reply = page.getByTestId('copilot-reply');
    if ((await reply.count()) === 0) return false;
    return (await reply.last().innerText()).includes('Evidencias citadas: ev');
  }, 'respuesta del Copilot con evidencias');
  const reply = await page.getByTestId('copilot-reply').last().innerText();
  assert(reply.includes('capa '));
  await capture(shot, 'copilot-panel');
  checks.push('FakeAIProvider citó evidencias y capas del foco real.');
}

async function askCopilotOffline(shot: string): Promise<void> {
  assert(electron);
  await electron.evaluate(() => {
    process.env.CYBERSOC_EVIDENCE_AI = 'OFFLINE';
  });
  await page.getByTestId('copilot-reset').click();
  await page
    .getByTestId('copilot-suggestion')
    .filter({ hasText: '¿Por qué fue marcado?' })
    .click();
  await until(async () => {
    const reply = page.getByTestId('copilot-reply');
    if ((await reply.count()) === 0) return false;
    return (await reply.last().innerText()).includes('Sin conexión con la IA.');
  }, 'aviso de IA no disponible');
  await capture(shot, 'copilot-panel');
  await page.getByTestId('nav-scan').click();
  await page.getByTestId('scan-folder').waitFor();
  checks.push(
    'FakeAIProvider en OFFLINE: mensaje claro y el escaneo sigue disponible.',
  );
}

async function publishVideo(file: string): Promise<void> {
  if (!video) {
    checks.push(
      'recordVideo no estuvo disponible: quedan 01a-detectado.png, 01b-cuarentena.png y 01c-restaurado.png.',
    );
    return;
  }
  const recording = video;
  await electron!.close();
  electron = undefined;
  video = null;
  const webm = join(root, 'cuarentena.webm');
  await recording.saveAs(webm);
  const mp4 = join(root, file);
  const env = environment();
  delete env.CYBERSOC_ANTHROPIC_API_KEY;
  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(import.meta.dirname, 'evidence/transcode-video.ps1'),
          '-SourcePath',
          webm,
          '-DestinationPath',
          mp4,
        ],
        { env, windowsHide: true, timeout: 75_000, stdio: 'pipe' },
      );
    } else {
      execFileSync(
        'ffmpeg',
        ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4],
        { env, windowsHide: true, timeout: 60_000, stdio: 'pipe' },
      );
    }
    assert.equal(readFileSync(mp4).subarray(4, 8).toString(), 'ftyp');
    copyFileSync(mp4, join(destination, file));
    generated.push(file);
    checks.push(
      'recordVideo de Playwright convertido a MP4 real, contenedor ftyp verificado.',
    );
  } catch {
    await recording.saveAs(join(destination, '01-video-ciclo-cuarentena.webm'));
    generated.push('01-video-ciclo-cuarentena.webm');
    limitations.push(
      `${file}: el conversor de video del sistema no pudo producir MP4; se entrega WebM.`,
    );
  }
  await launch();
}

function writeEvidenceText(file: string): void {
  assert.equal(basename(file), file);
  let body = '';
  if (file === '03-audit-log.txt') {
    const rows = query(
      'SELECT ts, actor, action, target_type AS targetType, target_id AS targetId FROM audit_log ORDER BY ts',
    );
    assert(rows.some((row) => row.action === 'QUARANTINE'));
    assert(rows.some((row) => row.action === 'RESTORE'));
    body = rows
      .map(
        (row) =>
          `${row.ts} ${row.actor} ${row.action} ${row.targetType ?? ''} ${row.targetId ?? ''}`,
      )
      .join('\n');
    checks.push('audit_log tiene QUARANTINE y RESTORE después del ciclo.');
  } else if (file === '07-registro-deleted.txt') {
    const rows = query(
      "SELECT id, original_path AS path, sha256, status, deleted_at AS deletedAt, reason, verdict_snapshot AS verdict FROM quarantine_items WHERE status = 'DELETED'",
    );
    assert(rows.length > 0);
    body = rows
      .map(
        (row) =>
          `${row.id} ${row.status} ${row.verdict} ${row.deletedAt}\n${row.path}\n${row.sha256}\n${row.reason}`,
      )
      .join('\n\n');
    checks.push('quarantine_items conserva una fila DELETED.');
  } else if (file === '13-boveda-csq.txt') {
    const vault = join(root, 'user-data', 'quarantine');
    const names = readdirSync(vault).filter((name) => name.endsWith('.csq'));
    assert(names.length > 0);
    const lines = ['Bóveda:', ...names.map((name) => `  ${name}`), ''];
    for (const name of names) {
      const bytes = readFileSync(join(vault, name)).subarray(0, 17);
      const header = bytes.subarray(0, 4).toString('utf8');
      assert.equal(header, 'CSQ1');
      assert.notEqual(bytes.subarray(0, 2).toString('utf8'), 'MZ');
      lines.push(
        `${name}: ${bytes.toString('hex')} (${header}, no es un ejecutable)`,
      );
    }
    body = lines.join('\n');
    checks.push('El .csq empieza por CSQ1 y no por MZ.');
  } else {
    throw new Error(`Consulta de evidencia desconocida: ${file}`);
  }
  writeFileSync(join(destination, file), `${body}\n`, 'utf8');
  generated.push(file);
  console.log(`Texto: ${file}`);
}

function safeMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : 'Error desconocido';
  const key = process.env.CYBERSOC_ANTHROPIC_API_KEY;
  if (key) message = message.replaceAll(key, '[REDACTED]');
  return message.slice(0, 2000);
}

try {
  const env = environment();
  delete env.CYBERSOC_ANTHROPIC_API_KEY;
  execFileSync(
    python,
    [
      join(import.meta.dirname, 'evidence/generate-fixtures.py'),
      join(engineRoot, 'tests/fixtures/generate.py'),
      root,
    ],
    { env, windowsHide: true, timeout: 30_000, stdio: 'pipe' },
  );
  await launch(sprint === '01' || sprint === '04');
  for (const step of steps) {
    console.log(
      `Paso: ${step.accion}${step.archivo ? ` → ${step.archivo}` : ''}`,
    );
    switch (step.accion) {
      case 'cancelar_3000':
        await cancellation(step.archivo!);
        break;
      case 'bloquear':
        await lockedFile(step.archivo!);
        break;
      case 'reiniciar':
        await restart(step.archivo!);
        break;
      case 'matar_motor':
        await crash(step.archivo!);
        break;
      case 'escanear':
        await scan(
          z.string().parse(step.parametros?.ruta),
          z.enum(['FILE', 'FOLDER']).parse(step.parametros?.tipo),
        );
        break;
      case 'seleccionar':
        await select(z.string().parse(step.parametros?.texto));
        break;
      case 'capturar':
        await capture(step.archivo!, step.selector);
        break;
      case 'configurar':
        await settings(step.archivo!);
        break;
      case 'esperar':
        await waitForText(
          z.string().parse(step.selector),
          z.string().parse(step.parametros?.texto),
        );
        break;
      case 'perfil':
        await profile(
          z.enum(['AUTO', 'CUSTOM']).parse(step.parametros?.modo),
          step.parametros?.capas,
        );
        break;
      case 'cuarentena':
        await quarantineFile(
          fixtureName(z.string().parse(step.parametros?.texto)),
        );
        break;
      case 'abrir_cuarentena':
        await openQuarantine(
          fixtureName(z.string().parse(step.parametros?.texto)),
        );
        break;
      case 'restaurar':
        await restoreQuarantine(
          fixtureName(z.string().parse(step.parametros?.texto)),
        );
        break;
      case 'restaurar_otra':
        await restoreWithoutOverwrite(
          fixtureName(z.string().parse(step.parametros?.texto)),
          z.string().parse(step.archivo),
        );
        break;
      case 'eliminar':
        await deleteQuarantine(
          fixtureName(z.string().parse(step.parametros?.texto)),
          z.string().parse(step.archivo),
        );
        break;
      case 'copilot':
        await askCopilot(
          z.string().parse(step.parametros?.texto),
          z.string().parse(step.archivo),
        );
        break;
      case 'copilot_offline':
        await askCopilotOffline(z.string().parse(step.archivo));
        break;
      case 'guardar_video':
        await publishVideo(z.string().parse(step.archivo));
        break;
      case 'consultar':
        writeEvidenceText(z.string().parse(step.archivo));
        break;
    }
  }
  if (sprint === '04') {
    const required = [
      '02-pantalla-cuarentena.png',
      '03-audit-log.txt',
      '05-restaurar-sin-sobrescribir.png',
      '06-eliminar-confirmacion.png',
      '07-registro-deleted.txt',
      '10-copilot-explica.png',
      '12-copilot-sin-ia.png',
      '13-boveda-csq.txt',
    ];
    for (const file of required) {
      assert(existsSync(join(destination, file)), `Falta ${file}`);
    }
    const videoFile = existsSync(
      join(destination, '01-video-ciclo-cuarentena.mp4'),
    );
    const stills = [
      '01a-detectado.png',
      '01b-cuarentena.png',
      '01c-restaurado.png',
    ].every((file) => existsSync(join(destination, file)));
    assert(videoFile || stills, 'Falta el video o las capturas 01a/01b/01c');
  }
} catch (error) {
  if (page! && !page.isClosed()) {
    await page
      .screenshot({ path: join(root, 'capture-failure.png'), fullPage: true })
      .catch(() => {});
  }
  limitations.push(safeMessage(error));
  console.error(safeMessage(error));
  process.exitCode = 1;
} finally {
  lock?.stdin?.end('\n');
  lock?.kill();
  if (electron) await electron.close();
  // El temporal se conserva para auditoría; nunca se borra un directorio de usuario.
  const manifest = {
    sprint,
    date: new Date().toISOString(),
    provider: live ? 'Claude' : 'FakeAIProvider',
    temporaryRoot: root,
    generated,
    checks,
    limitations,
    completed: process.exitCode !== 1,
  };
  writeFileSync(
    join(destination, `capture-sprint-${sprint}.json`),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(
    `Archivos generados: ${generated.length}. Limitaciones: ${limitations.length}.`,
  );
}

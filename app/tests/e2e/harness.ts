import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from 'playwright';

export const appRoot = resolve(import.meta.dirname, '../..');
const engineRoot = resolve(appRoot, '../engine');
const python = join(
  engineRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

export interface EvidenceApp {
  app: ElectronApplication;
  page: Page;
  /** Carpeta temporal del modo evidencia. La BD vive en user-data/. */
  root: string;
}

function baseEnvironment(root: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.CYBERSOC_ANTHROPIC_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.CYBERSOC_ENGINE_CMD;
  return {
    ...env,
    CYBERSOC_EVIDENCE_MODE: '1',
    CYBERSOC_EVIDENCE_LIVE: '0',
    CYBERSOC_EVIDENCE_ROOT: root,
    CYBERSOC_EVIDENCE_SCAN_DELAY_MS: '0',
    CYBERSOC_EVIDENCE_DIALOG_PATH: '',
    CYBERSOC_EVIDENCE_REPLIES: '40',
    PYTHONPATH: join(engineRoot, 'src'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

/** Misma preparación que el capturador: fixtures inofensivos y BD aislada. */
export function prepareEvidenceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cybersoc-evidence-'));
  const env = baseEnvironment(root);
  delete env.CYBERSOC_ANTHROPIC_API_KEY;
  execFileSync(
    python,
    [
      join(appRoot, 'scripts/evidence/generate-fixtures.py'),
      join(engineRoot, 'tests/fixtures/generate.py'),
      root,
    ],
    { env, windowsHide: true, timeout: 30_000, stdio: 'pipe' },
  );
  const pause = join(root, 'mitad');
  mkdirSync(pause);
  for (let index = 0; index < 16; index += 1) {
    writeFileSync(
      join(pause, `nota-${String(index).padStart(2, '0')}.txt`),
      `Texto inofensivo de demostracion ${index}.\n`,
      'utf8',
    );
  }
  return root;
}

/** Deja pydantic y el motor en caché. El saludo del motor espera solo 5 s. */
function warmEngine(root: string): void {
  execFileSync(python, ['-c', 'import cybersoc_engine'], {
    env: baseEnvironment(root),
    windowsHide: true,
    timeout: 30_000,
    stdio: 'pipe',
  });
}

export async function launchEvidence(root: string): Promise<EvidenceApp> {
  warmEngine(root);
  const app = await electron.launch({
    args: [appRoot],
    cwd: appRoot,
    env: baseEnvironment(root),
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.getByTestId('nav-status').waitFor({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1400, 900);
  });
  await page.getByTestId('nav-status').click();
  await expectConnected(page);
  const userData = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath('userData'),
  );
  if (userData !== join(root, 'user-data')) {
    throw new Error(`La BD no quedó aislada. userData=${userData}`);
  }
  return { app, page, root };
}

async function expectConnected(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
  let reconnects = 0;
  let disconnectedSince = 0;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.getByTestId('engine-status').innerText();
    if (last.includes('Motor: conectado')) return;
    if (last.includes('incompatible')) {
      throw new Error(`El motor quedó incompatible: ${last}`);
    }
    if (last.includes('desconectado')) {
      if (disconnectedSince === 0) disconnectedSince = Date.now();
      const button = page.getByRole('button', { name: 'Reconectar' });
      if (
        Date.now() - disconnectedSince > 8_000 &&
        reconnects < 3 &&
        (await button.isEnabled())
      ) {
        reconnects += 1;
        disconnectedSince = 0;
        await button.click();
      }
    } else {
      disconnectedSince = 0;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`El motor no se conectó. Último estado: ${last}`);
}

/** El diálogo nativo no se abre: main lee esta ruta del modo evidencia. */
export async function pointDialog(
  app: ElectronApplication,
  target: string,
  delayMs = 0,
): Promise<void> {
  await app.evaluate(
    (_electron, values: { target: string; delayMs: number }) => {
      process.env.CYBERSOC_EVIDENCE_DIALOG_PATH = values.target;
      process.env.CYBERSOC_EVIDENCE_SCAN_DELAY_MS = String(values.delayMs);
    },
    { target, delayMs },
  );
}

export function query(root: string, sql: string): Record<string, unknown>[] {
  const database = new DatabaseSync(join(root, 'user-data/cybersoc.db'), {
    readOnly: true,
  });
  try {
    return database.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

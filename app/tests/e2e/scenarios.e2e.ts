import { join } from 'node:path';
import { expect, test } from 'playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchEvidence,
  pointDialog,
  prepareEvidenceRoot,
  query,
  sha256File,
  type EvidenceApp,
} from './harness';

let session: EvidenceApp;

async function scanFolder(
  app: ElectronApplication,
  page: Page,
  folder: string,
  delayMs = 0,
): Promise<void> {
  await page.getByTestId('nav-scan').click();
  await pointDialog(app, folder, delayMs);
  await page.getByTestId('scan-folder').click();
  await expect(page.getByTestId('job-detail')).toContainText(folder, {
    timeout: 30_000,
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const root = prepareEvidenceRoot();
  session = await launchEvidence(root);
});

test.afterAll(async () => {
  await session?.app.close();
});

test('1. escanear fixtures muestra los veredictos esperados', async () => {
  const folder = join(session.root, 'fixtures');
  await scanFolder(session.app, session.page, folder);
  await expect(session.page.getByTestId('job-status')).toContainText(
    'Completado',
    { timeout: 90_000 },
  );
  const detected = session.page
    .getByTestId('result-row')
    .filter({ hasText: 'CSD-TEST-001.txt' });
  await expect(detected).toContainText('Detectado');
  await expect(
    session.page
      .getByTestId('result-row')
      .filter({ hasText: 'CSD-TEST-005.txt' }),
  ).toContainText('Detectado');
  await expect(
    session.page
      .getByTestId('result-row')
      .filter({ hasText: 'Limpio' })
      .first(),
  ).toBeVisible();
  const stored = query(
    session.root,
    `SELECT verdict FROM scan_results WHERE file_name = 'CSD-TEST-001.txt'`,
  );
  expect(stored[0]?.verdict).toBe('DETECTED');
});

test('2. cancelar a mitad deja el trabajo CANCELLED', async () => {
  const folder = join(session.root, 'mitad');
  await scanFolder(session.app, session.page, folder, 300);
  await expect
    .poll(
      async () => {
        const processed = Number(
          await session.page.getByTestId('processed-count').innerText(),
        );
        const discovered = Number(
          await session.page.getByTestId('discovered-count').innerText(),
        );
        return processed >= 2 && discovered > processed;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await pointDialog(session.app, folder, 3000);
  await session.page.getByTestId('cancel-scan').click();
  await expect(session.page.getByTestId('job-status')).toContainText(
    'Cancelado',
    { timeout: 30_000 },
  );
  const row = query(
    session.root,
    `SELECT status, files_processed AS processed, files_discovered AS discovered
     FROM scan_jobs ORDER BY rowid DESC LIMIT 1`,
  )[0];
  expect(row?.status).toBe('CANCELLED');
  expect(Number(row?.processed)).toBeGreaterThan(0);
  expect(Number(row?.processed)).toBeLessThan(Number(row?.discovered));
});

test('3. abrir una detección muestra evidencia, traza y análisis simulado', async () => {
  await session.page.getByTestId('nav-history').click();
  await session.page
    .getByTestId('history-job')
    .filter({ hasText: 'fixtures' })
    .click();
  await session.page
    .getByTestId('result-row')
    .filter({ hasText: 'CSD-TEST-001.txt' })
    .click();
  await expect(session.page.getByTestId('result-summary')).toContainText(
    'CSD-TEST-001.txt',
  );
  await expect(session.page.getByTestId('result-summary')).toContainText(
    'Detectado',
  );
  await expect(session.page.getByTestId('evidence-panel')).toContainText(
    'SIGNATURE_MATCH',
  );
  await expect(session.page.getByTestId('layers-applied')).toContainText(
    'HASH',
  );
  await expect(session.page.getByTestId('layer-status-HASH')).toHaveText('RAN');
  await expect(session.page.getByTestId('layers-applied')).toContainText(
    'SIGNATURES',
  );
  await expect(session.page.getByTestId('decision-panel')).toContainText(
    '¿Cómo se decidió?',
  );
  const analysis = session.page.getByTestId('ai-analysis');
  try {
    await expect(analysis).toContainText('FakeAIProvider', { timeout: 20_000 });
  } catch {
    await session.page.getByTestId('analyze-with-ai').click();
    await expect(analysis).toContainText('FakeAIProvider', { timeout: 30_000 });
  }
});

test('4. cuarentena y restauración conservan el hash', async () => {
  const original = join(session.root, 'fixtures', 'CSD-TEST-001.txt');
  const before = sha256File(original);
  const stored = query(
    session.root,
    `SELECT sha256 FROM scan_results WHERE file_name = 'CSD-TEST-001.txt'`,
  );
  expect(stored[0]?.sha256).toBe(before);
  await session.page.getByTestId('quarantine-file').click();
  await session.page.getByTestId('quarantine-confirm').click();
  await expect(session.page.getByTestId('quarantine-dialog')).toHaveCount(0, {
    timeout: 30_000,
  });
  await session.page.getByTestId('nav-quarantine').click();
  const row = session.page
    .getByTestId('quarantine-row')
    .filter({ hasText: 'CSD-TEST-001.txt' });
  await expect(row).toBeVisible();
  await row.getByTestId('quarantine-restore').click();
  await session.page.getByTestId('quarantine-restore-confirm').click();
  await session.page.getByTestId('quarantine-restore-detected-confirm').click();
  await expect(row).toContainText('Restaurado', { timeout: 30_000 });
  expect(sha256File(original)).toBe(before);
});

test('5. el Copilot simulado muestra chips de referencia', async () => {
  await session.page.getByTestId('nav-history').click();
  await session.page
    .getByTestId('history-job')
    .filter({ hasText: 'fixtures' })
    .click();
  await session.page
    .getByTestId('copilot-message')
    .fill('Muéstrame los archivos con mayor riesgo');
  await session.page.getByTestId('copilot-send').click();
  const chip = session.page.getByTestId('copilot-reference').first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(session.page.getByTestId('copilot-reply').last()).toContainText(
    'mayor riesgo',
  );
});

test('6. reiniciar la app conserva el historial', async () => {
  const before = query(
    session.root,
    'SELECT id FROM scan_jobs ORDER BY rowid',
  ).map((row) => String(row.id));
  expect(before.length).toBeGreaterThanOrEqual(2);
  await session.app.close();
  session = await launchEvidence(session.root);
  const after = query(
    session.root,
    'SELECT id FROM scan_jobs ORDER BY rowid',
  ).map((row) => String(row.id));
  expect(after).toEqual(before);
  await session.page.getByTestId('nav-history').click();
  await expect(
    session.page.getByTestId('history-job').filter({ hasText: 'fixtures' }),
  ).toContainText('Completado');
  await expect(
    session.page.getByTestId('history-job').filter({ hasText: 'mitad' }),
  ).toContainText('Cancelado');
});

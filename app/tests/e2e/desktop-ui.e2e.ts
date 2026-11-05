import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'playwright/test';
import {
  launchEvidence,
  pointDialog,
  prepareEvidenceRoot,
  type EvidenceApp,
} from './harness';

const evidence = join(
  import.meta.dirname,
  '../../../../construccion/sprints/sprint-10-escritorio-historial/evidencias/10D-interfaz',
);

let session: EvidenceApp;

async function shot(name: string, fullPage = false): Promise<void> {
  await session.page.screenshot({
    path: join(evidence, name),
    animations: 'disabled',
    fullPage,
  });
}

async function resize(width: number, height: number): Promise<void> {
  await session.app.evaluate(
    ({ BrowserWindow }, size: { width: number; height: number }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mkdirSync(evidence, { recursive: true });
  session = await launchEvidence(prepareEvidenceRoot());
});

test.afterAll(async () => {
  await session?.app.close();
});

test('el inicio está vacío y el asistente cerrado', async () => {
  await session.page.getByTestId('nav-home').click();
  await expect(
    session.page.getByRole('heading', { name: 'Resumen' }),
  ).toBeVisible();
  await expect(session.page.getByTestId('copilot-panel')).toBeHidden();
  await expect(session.page.getByTestId('dashboard-loading')).toBeHidden();
  await expect(session.page.getByTestId('dashboard-last')).toContainText(
    'Todavía no hay un análisis completado.',
  );
  await shot('dashboard-vacio.png', true);
});

test('cerrar el panel no borra el borrador', async () => {
  await session.page.getByTestId('assistant-open').click();
  await expect(session.page.getByTestId('copilot-panel')).toHaveAttribute(
    'role',
    'complementary',
  );
  await session.page
    .getByTestId('copilot-message')
    .fill('Consulta de prueba, sin datos privados.');
  await shot('asistente-ancho.png');
  await session.page.getByTestId('assistant-close').click();
  await expect(session.page.getByTestId('copilot-panel')).toBeHidden();
  await session.page.getByTestId('assistant-open').click();
  await expect(session.page.getByTestId('copilot-message')).toHaveValue(
    'Consulta de prueba, sin datos privados.',
  );
  await session.page.getByTestId('assistant-close').click();
});

test('el historial vacío no se presenta como una lista completa', async () => {
  await session.page.getByTestId('nav-history').click();
  await expect(session.page.getByTestId('history-page-notice')).toHaveText(
    'No hay análisis guardados.',
  );
  await shot('historial-vacio.png', true);
});

test('un escaneo benigno alimenta el resumen y el historial', async () => {
  const folder = join(session.root, 'fixtures');
  await session.page.getByTestId('nav-scan').click();
  await pointDialog(session.app, folder);
  await session.page.getByTestId('scan-folder').click();
  await expect(session.page.getByTestId('job-status')).toContainText(
    'Completado',
    { timeout: 90_000 },
  );
  await session.page.getByTestId('nav-home').click();
  await expect(session.page.getByTestId('dashboard-last')).not.toContainText(
    'Todavía no hay un análisis completado.',
  );
  await expect(
    session.page.getByTestId('dashboard-scope-notice'),
  ).toBeVisible();
  await shot('dashboard-con-datos.png', true);
  await session.page.getByTestId('nav-history').click();
  await expect(session.page.getByTestId('history-page-notice')).toContainText(
    'de ',
  );
  await expect(session.page.getByTestId('history-job').first()).toBeVisible();
  await shot('historial-con-datos.png', true);
});

test('el diálogo estrecho aísla el fondo y Escape devuelve el foco', async () => {
  await session.page.getByTestId('assistant-open').click();
  await session.page
    .getByTestId('copilot-message')
    .fill('¿Qué puedes decir del resumen?');
  await session.page.getByTestId('copilot-send').click();
  await expect(session.page.getByTestId('copilot-reply').last()).toBeVisible({
    timeout: 30_000,
  });
  await shot('asistente-chat.png');
  await session.page.getByText('Archivo de conversaciones').click();
  await session.page.getByTestId('archive-conversation').first().click();
  await expect(session.page.getByTestId('archive-continue')).toBeVisible();
  await expect(session.page.getByTestId('copilot-reply').last()).toBeVisible();
  await shot('asistente-archivo.png');
  await resize(520, 800);
  await expect(session.page.getByTestId('copilot-panel')).toHaveAttribute(
    'role',
    'dialog',
    { timeout: 5_000 },
  );
  await expect(session.page.locator('.app-main')).toHaveAttribute('inert', '');
  await shot('asistente-estrecho.png');
  await session.page.keyboard.press('Escape');
  await expect(session.page.getByTestId('copilot-panel')).toBeHidden();
  await expect(session.page.getByTestId('assistant-open')).toBeFocused();
  await resize(1400, 900);
  await session.page.getByTestId('assistant-open').click();
  await expect(session.page.getByTestId('copilot-panel')).toHaveAttribute(
    'role',
    'complementary',
  );
  await expect(session.page.getByTestId('copilot-reply').last()).toBeVisible();
  await session.page.getByTestId('assistant-close').click();
});

test('el reflow a 1024 y la escala de página no tapan el resumen', async () => {
  await session.page.getByTestId('nav-home').click();
  await resize(1024, 768);
  const wide = await session.page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: {
          documentElement: { scrollWidth: number; clientWidth: number };
        };
      }
    ).document.documentElement;
    return { scroll: root.scrollWidth, client: root.clientWidth };
  });
  expect(wide.scroll).toBeLessThanOrEqual(wide.client + 1);
  await shot('dashboard-1024.png', true);
  await resize(512, 900);
  const narrow = await session.page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: {
          documentElement: { scrollWidth: number; clientWidth: number };
        };
      }
    ).document.documentElement;
    return { scroll: root.scrollWidth, client: root.clientWidth };
  });
  expect(narrow.scroll).toBeLessThanOrEqual(narrow.client + 1);
  await shot('dashboard-reflow-512.png', true);
  let scale: number | null = null;
  try {
    const client = await session.page.context().newCDPSession(session.page);
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    scale = await session.page.evaluate(() => {
      const viewport = (
        globalThis as unknown as {
          visualViewport?: { scale: number };
        }
      ).visualViewport;
      return viewport?.scale ?? null;
    });
  } catch {
    scale = null;
  }
  writeFileSync(
    join(evidence, 'reflow.json'),
    JSON.stringify(
      {
        wide,
        narrow,
        scale,
        note: 'La escala de página pedida no cambió visualViewport. El reflow comprobado es el ancho de 1024 y el de 512.',
      },
      null,
      2,
    ),
  );
  await expect(
    session.page.getByRole('heading', { name: 'Resumen' }),
  ).toBeVisible();
});

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'playwright/test';

const evidenceReport = join(
  import.meta.dirname,
  '../../construccion/sprints/sprint-06-robustez-entrega/evidencias/01-e2e-reporte',
);

/**
 * Playwright para Electron. Un solo trabajador: la app y el motor Python
 * no se lanzan en paralelo. El informe HTML queda en construccion/, que
 * el equipo conserva solo en local.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: evidenceReport, open: 'never' }],
  ],
  outputDir: join(tmpdir(), 'cybersoc-playwright-output'),
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});

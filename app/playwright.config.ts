import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'playwright/test';

const evidenceReport = join(
  import.meta.dirname,
  '../../construccion/sprints/sprint-06-robustez-entrega/evidencias/01-e2e-reporte',
);

/**
 * Playwright for Electron. A single worker: the app and the Python engine
 * are not launched in parallel. The HTML report stays in construccion/, which
 * the team keeps locally only.
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

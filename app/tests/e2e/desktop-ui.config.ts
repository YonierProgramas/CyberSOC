import { join } from 'node:path';
import { defineConfig } from 'playwright/test';

const evidence = join(
  import.meta.dirname,
  '../../../../construccion/sprints/sprint-10-escritorio-historial/evidencias/10D-interfaz',
);

/** This walkthrough does not use the S6 HTML report. */
export default defineConfig({
  testDir: '.',
  testMatch: 'desktop-ui.e2e.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: join(evidence, 'playwright-output'),
  use: {
    screenshot: 'off',
    trace: 'off',
  },
});

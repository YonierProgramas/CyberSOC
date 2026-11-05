import { join } from 'node:path';
import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'desktop-corrections.e2e.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: join(
    import.meta.dirname,
    '../../../../construccion/sprints/sprint-10-escritorio-historial/evidencias/10D-interfaz/correccion-E09-E11/playwright-output',
  ),
});

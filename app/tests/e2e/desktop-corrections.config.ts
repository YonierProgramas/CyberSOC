import { tmpdir } from 'node:os';
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
  outputDir: join(tmpdir(), 'cybersoc-playwright-correcciones'),
});

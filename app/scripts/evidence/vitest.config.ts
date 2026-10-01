import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['scripts/evidence/mode.test.ts'], maxWorkers: 1 },
});

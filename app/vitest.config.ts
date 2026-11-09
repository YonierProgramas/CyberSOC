import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,js}'],
    clearMocks: true,
    // SQLite and Python processes compete for I/O on Windows. All cases run
    // serially, with the same timeouts and without skipping tests.
    maxWorkers: 1,
  },
});

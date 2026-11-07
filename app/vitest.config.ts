import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,js}'],
    clearMocks: true,
    // SQLite y procesos Python compiten por E/S en Windows. Todos los casos se
    // ejecutan en serie, con los mismos timeouts y sin omitir pruebas.
    maxWorkers: 1,
  },
});

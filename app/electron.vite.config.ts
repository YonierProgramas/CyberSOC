import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __CYBERSOC_RELEASE__: JSON.stringify(
        mode !== 'development' && mode !== 'instrumentation',
      ),
      __CYBERSOC_RESOURCE_DIGEST__: JSON.stringify(
        mode === 'development' || mode === 'instrumentation'
          ? ''
          : createHash('sha256')
              .update(readFileSync('out/packaging/resources-manifest.json'))
              .digest('hex'),
      ),
    },
    build: {
      outDir:
        mode === 'instrumentation' ? 'out/instrumentation/main' : 'out/main',
      minify: mode !== 'development',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  preload: {
    build: {
      outDir:
        mode === 'instrumentation'
          ? 'out/instrumentation/preload'
          : 'out/preload',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir:
        mode === 'instrumentation'
          ? 'out/instrumentation/renderer'
          : 'out/renderer',
    },
  },
}));

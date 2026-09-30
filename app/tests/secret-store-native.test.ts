import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')(
  'safeStorage real cifra en Windows y descifra en otro proceso Electron',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cybersoc-native-secret-'));
    const bundle = join(directory, 'main.cjs');
    const electron = createRequire(import.meta.url)('electron') as string;
    try {
      await build({
        entryPoints: [
          fileURLToPath(
            new URL('./fixtures/secret-store-native.ts', import.meta.url),
          ),
        ],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        logLevel: 'silent',
      });
      for (const phase of ['write', 'read']) {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const output = await new Promise<string>((resolveOutput, reject) => {
          const child = spawn(electron, [bundle, directory, phase], {
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.resume();
          const timer = setTimeout(() => {
            child.kill();
          }, 20_000);
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolveOutput(stdout);
            else reject(new Error('Falló el smoke de safeStorage nativo.'));
          });
        });
        expect(output).toContain('SECRET_STORE_NATIVE_OK');
      }
    } finally {
      expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true);
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  60_000,
);

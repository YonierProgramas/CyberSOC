import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { appConfigSchema } from '../../src/core/config/AppConfig';
import { generatedFixtures, realRuntime } from './real-runtime';

const engineRoot = fileURLToPath(new URL('../../../engine/', import.meta.url));
const fixturesHost = fileURLToPath(
  new URL('./fixtures-host.py', import.meta.url),
);

function filePaths(root: string): string[] {
  const paths: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile()) paths.push(path);
    }
  }
  return paths.sort();
}

function snapshot(path: string) {
  return {
    mtimeNs: statSync(path, { bigint: true }).mtimeNs,
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

it.each([false, true])(
  'Python real + SQLite: 25 hashes coinciden, archivos intactos, ciclo=%s (CA-1.1/1.6/1.9)',
  async (cycle) => {
    const scratch = mkdtempSync(join(tmpdir(), 'cybersoc-real-integration-'));
    let fixtures: Awaited<ReturnType<typeof generatedFixtures>> | undefined;
    let runtime: ReturnType<typeof realRuntime> | undefined;
    let junction: string | undefined;
    try {
      fixtures = await generatedFixtures(engineRoot, fixturesHost);
      const paths = filePaths(fixtures.root);
      expect(paths).toHaveLength(25);
      expect(
        [
          ...new Set(
            paths.map(
              (path) => relative(fixtures!.root, path).split(sep).length,
            ),
          ),
        ].sort(),
      ).toEqual([1, 2, 3]);
      expect(paths.some((path) => /ñ/.test(path))).toBe(true);
      expect(paths.some((path) => /ó/.test(path))).toBe(true);
      expect(paths.some((path) => path.includes('📄'))).toBe(true);
      const before = new Map(paths.map((path) => [path, snapshot(path)]));
      if (cycle) {
        const candidate = join(fixtures.root, 'nivel-2', 'vuelta-al-inicio');
        symlinkSync(fixtures.root, candidate, 'junction');
        junction = candidate;
        expect(lstatSync(junction).isSymbolicLink()).toBe(true);
      }
      runtime = realRuntime(
        engineRoot,
        join(scratch, 'scan.db'),
        appConfigSchema.parse({ scan: { queueCapacity: 2 } }),
      );
      await runtime.connect();
      const job = await runtime.scan(fixtures.root, 30_000);
      expect(job, runtime.logs.join('\n')).toMatchObject({
        status: 'COMPLETED',
        filesDiscovered: 25,
        filesProcessed: 25,
        filesError: 0,
        filesSkipped: 0,
      });
      const rows = runtime.results.listByJob(job.id, 0, 100);
      expect(rows).toHaveLength(25);
      expect(rows.map((row) => row.path).sort()).toEqual(paths);
      expect(new Set(rows.map((row) => row.seq)).size).toBe(25);
      for (const row of rows) {
        expect(row.status).toBe('SCANNED');
        expect(row.verdict).toBe('NOT_EVALUATED');
        expect(row.sha256).toBe(before.get(row.path)!.hash);
        expect(snapshot(row.path)).toEqual(before.get(row.path));
      }
      expect(filePaths(fixtures.root)).toEqual(paths);
      expect(runtime.jobs.get(job.id)).toEqual(job);
      expect(JSON.parse(job.metricsJson!)).toMatchObject({
        skippedLinks: cycle ? 1 : 0,
        engineRestarts: 0,
      });
      await expect(runtime.engine.ping()).resolves.toHaveProperty('ts');
    } finally {
      try {
        await runtime?.close();
      } finally {
        // Unlink only our own junction; never recursively remove its target.
        if (junction && fixtures) {
          expect(
            resolve(junction).startsWith(resolve(fixtures.root) + sep),
          ).toBe(true);
          unlinkSync(junction);
        }
        try {
          await fixtures?.close();
        } finally {
          expect(resolve(scratch).startsWith(resolve(tmpdir()) + sep)).toBe(
            true,
          );
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
  },
  60_000,
);

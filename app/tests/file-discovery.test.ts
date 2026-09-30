import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileDiscovery,
  type DiscoveryOptions,
} from '../src/core/scan/FileDiscovery';

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cybersoc-discovery-'));
  directories.push(directory);
  return directory;
}

async function collect(
  root: string,
  options?: DiscoveryOptions,
  signal?: AbortSignal,
) {
  const discovery = new FileDiscovery();
  const paths: string[] = [];
  for await (const file of discovery.discover(root, options, signal)) {
    paths.push(file.path);
  }
  return { discovery, paths };
}

function names(paths: string[]): string[] {
  return paths.map((file) => file.split(/[\\/]/).pop() ?? file).sort();
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileDiscovery', () => {
  it('encuentra archivos anidados y cuenta una carpeta vacia', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'a', 'sub'), { recursive: true });
    await mkdir(join(root, 'a', 'vacia'));
    await mkdir(join(root, 'b'));
    await writeFile(join(root, 'r.txt'), 'r');
    await writeFile(join(root, 'a', 'a1.txt'), 'a');
    await writeFile(join(root, 'a', 'sub', 'x.pdf'), 'x');
    await writeFile(join(root, 'b', 'b1.exe'), 'b');

    const { discovery, paths } = await collect(root);
    expect(names(paths)).toEqual(['a1.txt', 'b1.exe', 'r.txt', 'x.pdf']);
    expect(discovery.dirsVisited).toBe(5);
    expect(discovery.skippedLinks).toBe(0);
    expect(discovery.peakStackSize).toBeGreaterThan(0);
  });

  it('conserva ñ, tildes y emoji en las rutas', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'cañón'));
    await writeFile(join(root, 'cañón', 'José.txt'), 'j');
    await writeFile(join(root, 'nota-😀.txt'), 'e');

    const { paths } = await collect(root);
    expect(
      paths.some((file) => file.includes('cañón') && file.endsWith('José.txt')),
    ).toBe(true);
    expect(paths.some((file) => file.endsWith('nota-😀.txt'))).toBe(true);
  });

  it('recorre mas de 50 niveles sin recursion', async () => {
    const root = await tempDir();
    const parts = Array.from({ length: 55 }, (_, index) => `n${index}`);
    const deep = join(root, ...parts);
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'final.txt'), 'ok');

    const { discovery, paths } = await collect(root);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/final\.txt$/);
    expect(discovery.dirsVisited).toBe(56);
  });

  it('no sigue una junction que apunta a su carpeta padre', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'a'));
    await writeFile(join(root, 'visible.txt'), 'v');
    await writeFile(join(root, 'a', 'inside.txt'), 'i');
    await symlink(root, join(root, 'a', 'loop'), 'junction');

    const { discovery, paths } = await collect(root);
    expect(names(paths)).toEqual(['inside.txt', 'visible.txt']);
    expect(discovery.skippedLinks).toBe(1);
    expect(discovery.dirsVisited).toBe(2);
  });

  it('no entra en un nombre excluido', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'secretos'));
    await writeFile(join(root, 'ok.txt'), 'ok');
    await writeFile(join(root, 'secretos', 'hidden.txt'), 'no');

    const { discovery, paths } = await collect(root, { exclude: ['Secretos'] });
    expect(names(paths)).toEqual(['ok.txt']);
    expect(discovery.dirsVisited).toBe(1);
  });

  it('cancela antes de empezar y entre archivos', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'b.txt'), 'b');
    await writeFile(join(root, 'c.txt'), 'c');

    const blocked = new AbortController();
    blocked.abort();
    const none = await collect(root, {}, blocked.signal);
    expect(none.paths).toEqual([]);
    expect(none.discovery.dirsVisited).toBe(0);

    const controller = new AbortController();
    const discovery = new FileDiscovery();
    const found: string[] = [];
    for await (const file of discovery.discover(root, {}, controller.signal)) {
      found.push(file.path);
      controller.abort();
    }
    expect(found).toHaveLength(1);
  });

  it('bfs encuentra los mismos archivos usando la Queue', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await writeFile(join(root, 'a', 'a.txt'), 'a');
    await writeFile(join(root, 'b', 'b.txt'), 'b');

    const depth = await collect(root, { strategy: 'dfs' });
    const breadth = await collect(root, { strategy: 'bfs' });
    expect(names(breadth.paths)).toEqual(names(depth.paths));
    expect(breadth.discovery.peakStackSize).toBe(0);
    expect(breadth.discovery.peakFrontier).toBeGreaterThan(0);
    expect(depth.discovery.peakStackSize).toBeGreaterThan(0);
  });
});

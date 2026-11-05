import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileDiscovery } from '../src/core/scan/FileDiscovery';

// AUD-10: las omisiones esperables se cuentan por motivo. Los errores se simulan por
// nombre de fixture para no alterar permisos reales del sistema; todo lo demás usa
// el sistema de archivos real en una carpeta temporal.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fail = (code: string) =>
    Object.assign(new Error(`simulado ${code}`), { code });
  return {
    ...actual,
    lstat: vi.fn(async (path: string) => {
      if (path.includes('bloqueado-eacces')) throw fail('EACCES');
      if (path.includes('desaparecido-enoent')) throw fail('ENOENT');
      if (path.includes('roto-eio')) throw fail('EIO');
      return actual.lstat(path);
    }),
    readdir: vi.fn(async (path: string) => {
      if (path.includes('carpeta-eperm')) throw fail('EPERM');
      return actual.readdir(path);
    }),
  };
});

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cybersoc-omisiones-'));
  directories.push(directory);
  return directory;
}

async function names(discovery: FileDiscovery, root: string) {
  const found: string[] = [];
  for await (const file of discovery.discover(root)) {
    found.push(file.path.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return found.sort();
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FileDiscovery: omisiones registradas', () => {
  it('cuenta cada entrada no leída por motivo y sigue con el resto', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'carpeta-eperm'));
    await mkdir(join(root, 'sub'));
    await Promise.all(
      [
        'ok.txt',
        'bloqueado-eacces.txt',
        'desaparecido-enoent.txt',
        'carpeta-eperm/dentro.txt',
        'sub/visible.txt',
      ].map((name) => writeFile(join(root, name), 'fixture inofensivo')),
    );
    const discovery = new FileDiscovery();

    expect(await names(discovery, root)).toEqual(['ok.txt', 'sub/visible.txt']);
    expect(discovery.skippedEntries).toBe(3);
    expect(discovery.skippedByReason).toEqual({
      EACCES: 1,
      ENOENT: 1,
      EPERM: 1,
    });
  });

  it('reinicia los conteos en cada recorrido', async () => {
    const first = await tempDir();
    await writeFile(join(first, 'bloqueado-eacces.txt'), 'x');
    const clean = await tempDir();
    await writeFile(join(clean, 'normal.txt'), 'x');
    const discovery = new FileDiscovery();

    await names(discovery, first);
    expect(discovery.skippedEntries).toBe(1);
    expect(await names(discovery, clean)).toEqual(['normal.txt']);
    expect(discovery.skippedEntries).toBe(0);
    expect(discovery.skippedByReason).toEqual({});
  });

  it('un error inesperado no se convierte en omisión silenciosa', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'roto-eio.txt'), 'x');
    const discovery = new FileDiscovery();

    await expect(names(discovery, root)).rejects.toMatchObject({ code: 'EIO' });
    expect(discovery.skippedEntries).toBe(0);
  });
});

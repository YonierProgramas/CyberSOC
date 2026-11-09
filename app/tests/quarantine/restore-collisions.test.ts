import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exists } from '../../src/core/quarantine/paths';
import { QuarantineHarness, sha } from './harness';

vi.setConfig({ testTimeout: 20_000 });

let h: QuarantineHarness;
beforeEach(async () => {
  h = new QuarantineHarness();
  await h.setup();
});
afterEach(() => h.close());

async function quarantined(name = 'original.txt') {
  const input = await h.seed(name);
  const item = await h.manager.quarantine(input.id);
  return { input, item };
}

/** Correct restoration: identical content, no blob or temporaries, RESTORED state. */
async function expectRestored(itemId: string, hash: string) {
  const record = h.record(itemId);
  expect(record.status).toBe('RESTORED');
  expect(sha(await fs.readFile(record.restoredTo!))).toBe(hash);
  expect(await exists(record.vaultFile)).toBe(false);
  expect(await h.restoreTemps(dirname(record.restoredTo!))).toEqual([]);
  return record.restoredTo!;
}

it('onto an existing file: does not overwrite it and restores with a suffix', async () => {
  const { input, item } = await quarantined();
  await fs.writeFile(input.path, 'Archivo nuevo del usuario');
  const target = await (async () => {
    await h.manager.restore(item.id, { trustHash: false });
    return expectRestored(item.id, input.hash);
  })();
  expect(target).toBe(join(h.root, 'original.restored-1.txt'));
  expect(await fs.readFile(input.path, 'utf8')).toBe(
    'Archivo nuevo del usuario',
  );
});

it('onto a chain of taken suffixes: looks for the next free one without touching any', async () => {
  const { input, item } = await quarantined();
  const taken = [
    'original.txt',
    'original.restored-1.txt',
    'original.restored-2.txt',
  ];
  for (const name of taken) await fs.writeFile(join(h.root, name), name);
  await h.manager.restore(item.id, { trustHash: false });
  expect(await expectRestored(item.id, input.hash)).toBe(
    join(h.root, 'original.restored-3.txt'),
  );
  for (const name of taken)
    expect(await fs.readFile(join(h.root, name), 'utf8')).toBe(name);
});

it('onto a folder with the same name as the original: the folder and its content stay intact', async () => {
  const { input, item } = await quarantined();
  await fs.mkdir(input.path);
  await fs.writeFile(join(input.path, 'dentro.txt'), 'no tocar');
  await h.manager.restore(item.id, { trustHash: false });
  const target = await expectRestored(item.id, input.hash);
  expect(target).not.toBe(input.path);
  expect((await fs.stat(input.path)).isDirectory()).toBe(true);
  expect(await fs.readdir(input.path)).toEqual(['dentro.txt']);
  expect(await fs.readFile(join(input.path, 'dentro.txt'), 'utf8')).toBe(
    'no tocar',
  );
});

it('targetPath that is an existing folder: neither replaces it nor writes inside another protected path', async () => {
  const { input, item } = await quarantined();
  const folder = join(h.root, 'destino');
  await fs.mkdir(folder);
  await fs.writeFile(join(folder, 'previo.txt'), 'previo');
  await h.manager.restore(item.id, { trustHash: false, targetPath: folder });
  const target = await expectRestored(item.id, input.hash);
  expect(target).not.toBe(folder);
  expect(dirname(target)).toBe(h.root);
  expect(await fs.readdir(folder)).toEqual(['previo.txt']);
});

it('targetPath with a trailing slash to an existing folder: does not replace it either', async () => {
  const { input, item } = await quarantined();
  const folder = join(h.root, 'destino');
  await fs.mkdir(folder);
  await h.manager.restore(item.id, {
    trustHash: false,
    targetPath: `${folder}\\`,
  });
  await expectRestored(item.id, input.hash);
  expect((await fs.stat(folder)).isDirectory()).toBe(true);
  expect(await fs.readdir(folder)).toEqual([]);
});

it('original folder deleted: fails without changing the state or losing the blob', async () => {
  const { input, item } = await quarantined('sub/original.txt');
  await fs.rm(dirname(input.path), { recursive: true });
  await expect(
    h.manager.restore(item.id, { trustHash: false }),
  ).rejects.toThrow();
  const record = h.record(item.id);
  expect(record.status).toBe('QUARANTINED');
  expect(record.restoredTo).toBeNull();
  expect(await exists(item.vaultFile)).toBe(true);
});

it('a part of the target path is a file, not a folder: fails without changing anything', async () => {
  const { item } = await quarantined();
  await fs.writeFile(join(h.root, 'archivo'), 'soy un archivo');
  await expect(
    h.manager.restore(item.id, {
      trustHash: false,
      targetPath: join(h.root, 'archivo', 'x.txt'),
    }),
  ).rejects.toThrow();
  expect(h.record(item.id).status).toBe('QUARANTINED');
  expect(await fs.readFile(join(h.root, 'archivo'), 'utf8')).toBe(
    'soy un archivo',
  );
});

it('the target folder is a junction: rejected without writing to its destination', async () => {
  const { item } = await quarantined();
  const real = join(h.root, 'real');
  await fs.mkdir(real);
  await fs.symlink(real, join(h.root, 'enlace'), 'junction');
  await expect(
    h.manager.restore(item.id, {
      trustHash: false,
      targetPath: join(h.root, 'enlace', 'x.txt'),
    }),
  ).rejects.toMatchObject({ code: 'UNSAFE_LINK' });
  expect(await fs.readdir(real)).toEqual([]);
  expect(h.record(item.id).status).toBe('QUARANTINED');
});

it('the target appears between confirmation and publishing: not overwritten (atomic link)', async () => {
  const { input, item } = await quarantined();
  h.confirm.mockImplementation(async (request) => {
    // The user confirms; right after, another program creates the target file.
    if (request.action === 'RESTORE_DETECTED')
      await fs.writeFile(input.path, 'creado en la carrera');
    return true;
  });
  await expect(
    h.manager.restore(item.id, { trustHash: false }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(input.path, 'utf8')).toBe('creado en la carrera');
  expect(h.record(item.id).status).toBe('QUARANTINED');
  expect(await exists(item.vaultFile)).toBe(true);
  expect(await h.restoreTemps()).toEqual([]);
});

it('two items restored at once to the same targetPath: only one takes it and the other stays quarantined', async () => {
  const a = await quarantined('a.txt');
  const b = await quarantined('b.txt');
  const target = join(h.root, 'mismo-destino.txt');
  const results = await Promise.allSettled([
    h.manager.restore(a.item.id, { trustHash: false, targetPath: target }),
    h.manager.restore(b.item.id, { trustHash: false, targetPath: target }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  // Both may finish (the second with a suffix) or one may fail with EEXIST; never overwrite.
  const statuses = [h.record(a.item.id).status, h.record(b.item.id).status];
  expect(ok.length).toBeGreaterThanOrEqual(1);
  expect(statuses.every((s) => s === 'RESTORED' || s === 'QUARANTINED')).toBe(
    true,
  );
  const hashes = new Set([a.input.hash, b.input.hash]);
  expect(hashes.has(sha(await fs.readFile(target)))).toBe(true);
  for (const id of [a.item.id, b.item.id]) {
    const record = h.record(id);
    if (record.status === 'RESTORED')
      expect(sha(await fs.readFile(record.restoredTo!))).toBe(record.sha256);
    else expect(await exists(record.vaultFile)).toBe(true);
  }
  expect(await h.restoreTemps()).toEqual([]);
});

it('the same item cannot be restored twice', async () => {
  const { input, item } = await quarantined();
  await h.manager.restore(item.id, { trustHash: false });
  await expect(
    h.manager.restore(item.id, { trustHash: false }),
  ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(await fs.readdir(h.root)).not.toContain('original.restored-1.txt');
  expect(sha(await fs.readFile(input.path))).toBe(input.hash);
});

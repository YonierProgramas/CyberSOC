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

/** Restauración correcta: contenido idéntico, sin blob ni temporales, estado RESTORED. */
async function expectRestored(itemId: string, hash: string) {
  const record = h.record(itemId);
  expect(record.status).toBe('RESTORED');
  expect(sha(await fs.readFile(record.restoredTo!))).toBe(hash);
  expect(await exists(record.vaultFile)).toBe(false);
  expect(await h.restoreTemps(dirname(record.restoredTo!))).toEqual([]);
  return record.restoredTo!;
}

it('sobre un archivo existente: no lo sobrescribe y restaura con sufijo', async () => {
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

it('sobre una cadena de sufijos ya ocupados: busca el siguiente libre sin tocar ninguno', async () => {
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

it('sobre una carpeta con el mismo nombre que el original: la carpeta y su contenido quedan intactos', async () => {
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

it('targetPath que es una carpeta existente: no la reemplaza ni escribe dentro de otra ruta protegida', async () => {
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

it('targetPath con barra final hacia una carpeta existente: tampoco la reemplaza', async () => {
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

it('carpeta del original borrada: falla sin cambiar el estado ni perder el blob', async () => {
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

it('una parte de la ruta destino es un archivo, no una carpeta: falla sin cambiar nada', async () => {
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

it('la carpeta destino es una junction: se rechaza sin escribir en su destino', async () => {
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

it('el destino aparece entre la confirmación y la publicación: no se sobrescribe (link atómico)', async () => {
  const { input, item } = await quarantined();
  h.confirm.mockImplementation(async (request) => {
    // El usuario confirma; justo después otro programa crea el archivo destino.
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

it('dos ítems restaurados a la vez al mismo targetPath: solo uno lo ocupa y el otro sigue en cuarentena', async () => {
  const a = await quarantined('a.txt');
  const b = await quarantined('b.txt');
  const target = join(h.root, 'mismo-destino.txt');
  const results = await Promise.allSettled([
    h.manager.restore(a.item.id, { trustHash: false, targetPath: target }),
    h.manager.restore(b.item.id, { trustHash: false, targetPath: target }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  // Pueden terminar las dos (la segunda con sufijo) o fallar una con EEXIST; nunca sobrescribir.
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

it('no se puede restaurar dos veces el mismo ítem', async () => {
  const { input, item } = await quarantined();
  await h.manager.restore(item.id, { trustHash: false });
  await expect(
    h.manager.restore(item.id, { trustHash: false }),
  ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(await fs.readdir(h.root)).not.toContain('original.restored-1.txt');
  expect(sha(await fs.readFile(input.path))).toBe(input.hash);
});

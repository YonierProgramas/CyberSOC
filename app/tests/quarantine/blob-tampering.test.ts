import { createCipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuarantineItem } from '../../src/core/persistence/QuarantineRepository';
import { exists } from '../../src/core/quarantine/paths';
import { QuarantineHarness, sha, type Seeded } from './harness';

vi.setConfig({ testTimeout: 20_000 });

// 3 MB + 47 bytes: más de un bloque de lectura (1 MB), para alterar zonas que el descifrado
// procesa después de haber escrito ya texto plano en el temporal.
const BIG = Buffer.alloc(3 * 1024 * 1024 + 47, 'Texto inofensivo. ');
const HEADER = 17;
const TAG = 16;

let h: QuarantineHarness;
let input: Seeded;
let item: QuarantineItem;
let pristine: Buffer;
beforeEach(async () => {
  h = new QuarantineHarness();
  await h.setup();
  input = await h.seed('grande.txt', BIG);
  item = await h.manager.quarantine(input.id);
  pristine = await fs.readFile(item.vaultFile);
});
afterEach(() => h.close());

/** Tras un ataque: nada se restaura, el blob (tal como quedó) se conserva y el ítem sigue en cuarentena. */
async function expectRefused(blobAfter?: Buffer) {
  await expect(
    h.manager.restore(item.id, { trustHash: false }),
  ).rejects.toThrow();
  const record = h.record(item.id);
  expect(record.status).toBe('QUARANTINED');
  expect(record.restoredTo).toBeNull();
  expect(await exists(input.path)).toBe(false);
  expect(await h.restoreTemps()).toEqual([]);
  expect(await exists(item.vaultFile)).toBe(true);
  if (blobAfter)
    expect((await fs.readFile(item.vaultFile)).equals(blobAfter)).toBe(true);
  const last = h.manager.audit.list(item.id).at(-1)!;
  expect(last.action).toBe('RESTORE_FAILED');
  // La auditoría nunca guarda la clave.
  if (record.keyB64.length >= 16)
    expect(JSON.stringify(h.manager.audit.list())).not.toContain(record.keyB64);
}

describe('blob truncado o alterado', () => {
  const cases: Array<[string, (blob: Buffer) => Buffer]> = [
    ['truncado 1 byte', (b) => b.subarray(0, b.length - 1)],
    ['truncado a la mitad', (b) => b.subarray(0, b.length >> 1)],
    ['solo la cabecera', (b) => b.subarray(0, HEADER)],
    ['vacío', () => Buffer.alloc(0)],
    ['un byte de más al final', (b) => Buffer.concat([b, Buffer.from([0])])],
    [
      'tag sustituido por ceros',
      (b) => Buffer.concat([b.subarray(0, b.length - TAG), Buffer.alloc(TAG)]),
    ],
    ['último byte del tag cambiado', (b) => flip(b, b.length - 1)],
    ['byte del primer bloque cifrado', (b) => flip(b, HEADER + 10)],
    [
      'byte del último bloque cifrado (tras 3 MB)',
      (b) => flip(b, b.length - TAG - 5),
    ],
    ['versión de formato 2', (b) => withByte(b, 4, 2)],
    [
      'magia "MZ" de ejecutable en la cabecera',
      (b) => Buffer.concat([Buffer.from('MZ'), b.subarray(2)]),
    ],
    ['IV de la cabecera cambiado', (b) => flip(b, 8)],
    [
      'cifrado y tag intercambiados de sitio',
      (b) =>
        Buffer.concat([
          b.subarray(0, HEADER),
          b.subarray(b.length - TAG),
          b.subarray(HEADER, b.length - TAG),
        ]),
    ],
    [
      'contenido original en claro con el mismo tamaño',
      (b) =>
        Buffer.concat([b.subarray(0, HEADER), BIG, b.subarray(b.length - TAG)]),
    ],
  ];
  it.each(cases)(
    '%s: no se restaura y el blob no se destruye',
    async (_name, mutate) => {
      const mutated = mutate(pristine);
      await fs.writeFile(item.vaultFile, mutated);
      await expectRefused(mutated);
    },
  );

  it('blob de OTRO ítem copiado encima (formato válido, otra clave): se rechaza', async () => {
    const other = await h.seed('otro.txt', BIG);
    const second = await h.manager.quarantine(other.id);
    const foreign = await fs.readFile(second.vaultFile);
    await fs.writeFile(item.vaultFile, foreign);
    await expectRefused(foreign);
  });

  it('blob forjado con la misma cabecera e IV pero otra clave (contenido elegido por un atacante): se rechaza', async () => {
    const header = pristine.subarray(0, HEADER);
    const cipher = createCipheriv(
      'aes-256-gcm',
      randomBytes(32),
      header.subarray(5),
    );
    cipher.setAAD(header);
    const forged = Buffer.concat([
      header,
      cipher.update(Buffer.alloc(BIG.length, 'X')),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    await fs.writeFile(item.vaultFile, forged);
    await expectRefused(forged);
  });

  it('blob borrado de la bóveda: falla sin crear nada y el ítem no desaparece', async () => {
    await fs.unlink(item.vaultFile);
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toThrow();
    expect(h.record(item.id).status).toBe('QUARANTINED');
    expect(await exists(input.path)).toBe(false);
    expect(await h.restoreTemps()).toEqual([]);
  });

  it('blob sustituido por una carpeta: falla sin crear nada', async () => {
    await fs.unlink(item.vaultFile);
    await fs.mkdir(item.vaultFile);
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toThrow();
    expect(h.record(item.id).status).toBe('QUARANTINED');
    expect(await exists(input.path)).toBe(false);
  });

  it('bóveda reemplazada por una junction: se rechaza sin leer ni escribir a través de ella', async () => {
    const moved = `${h.vault.root}-movida`;
    await fs.rename(h.vault.root, moved);
    await fs.symlink(moved, h.vault.root, 'junction');
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toMatchObject({ code: 'UNSAFE_LINK' });
    expect(await exists(input.path)).toBe(false);
    expect(h.record(item.id).status).toBe('QUARANTINED');
    await expect(h.manager.delete(item.id)).rejects.toMatchObject({
      code: 'UNSAFE_LINK',
    });
    expect((await fs.readdir(moved)).length).toBe(1); // el blob sigue en su sitio real
    await fs.rm(h.vault.root); // quita solo la junction
    await fs.rename(moved, h.vault.root);
  });

  it('blob alterado ENTRE la verificación y el descifrado (carrera): no se publica ni queda texto plano', async () => {
    const verify = h.vault.verify.bind(h.vault);
    vi.spyOn(h.vault, 'verify').mockImplementationOnce(async (record, temp) => {
      const tag = await verify(record, temp);
      await fs.writeFile(
        item.vaultFile,
        flip(pristine, pristine.length - TAG - 5),
      );
      return tag;
    });
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toThrow();
    expect(await exists(input.path)).toBe(false);
    expect(await h.restoreTemps()).toEqual([]);
    const record = h.record(item.id);
    expect(record.status).toBe('QUARANTINED');
    expect(record.restoredTo).toBeNull();
    expect(h.manager.audit.list(item.id).map((r) => r.action)).toContain(
      'RESTORE_FAILED',
    );
  });

  it('el blob intacto, tras todos los fallos anteriores, sigue restaurando el SHA-256 exacto', async () => {
    await fs.writeFile(item.vaultFile, flip(pristine, HEADER + 10));
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toThrow();
    await fs.writeFile(item.vaultFile, pristine);
    const restored = await h.manager.restore(item.id, { trustHash: false });
    expect(sha(await fs.readFile(restored.restoredTo!))).toBe(input.hash);
  });
});

describe('clave, IV o metadatos incorrectos en la BD', () => {
  const cases: Array<
    [string, string, (current: string) => string | number | null]
  > = [
    [
      'clave aleatoria de 32 bytes',
      'key_b64',
      () => randomBytes(32).toString('base64'),
    ],
    ['clave de 16 bytes', 'key_b64', () => randomBytes(16).toString('base64')],
    ['clave vacía', 'key_b64', () => ''],
    ['clave que no es base64', 'key_b64', () => '¡no es base64!'],
    [
      'clave con un bit cambiado',
      'key_b64',
      (k) => flip(Buffer.from(k, 'base64'), 0).toString('base64'),
    ],
    ['IV aleatorio', 'iv_b64', () => randomBytes(12).toString('base64')],
    ['IV de 16 bytes', 'iv_b64', () => randomBytes(16).toString('base64')],
    ['IV vacío', 'iv_b64', () => ''],
    [
      'tag guardado distinto',
      'auth_tag_b64',
      () => randomBytes(16).toString('base64'),
    ],
    ['SHA-256 original distinto', 'sha256', () => 'f'.repeat(64)],
    ['tamaño original distinto', 'size_bytes', () => BIG.length - 1],
  ];
  it.each(cases)('%s: no se restaura nada', async (_name, column, value) => {
    // Solo el caso del bit cambiado usa la clave actual; los demás la ignoran.
    h.tamper(item.id, column, value(h.record(item.id).keyB64));
    await expectRefused(pristine);
  });

  it('tag nulo (como en una recuperación) y clave equivocada: GCM igualmente lo rechaza', async () => {
    h.tamper(item.id, 'auth_tag_b64', null);
    h.tamper(item.id, 'key_b64', randomBytes(32).toString('base64'));
    await expectRefused(pristine);
  });

  it('SHA-256 cambiado: el texto plano ya descifrado no queda en el temporal', async () => {
    // GCM autentica bien, así que el descifrado escribe los 3 MB en el temporal y solo
    // al final falla la comparación del hash: el temporal debe borrarse.
    const verify = vi.spyOn(h.vault, 'verify').mockResolvedValueOnce('tag');
    h.tamper(item.id, 'sha256', 'f'.repeat(64));
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    });
    expect(verify).toHaveBeenCalled();
    expect(await h.restoreTemps()).toEqual([]);
    expect(await exists(input.path)).toBe(false);
    expect(h.record(item.id).status).toBe('QUARANTINED');
  });

  it('ruta de bóveda manipulada en la BD: no lee ni borra fuera de la bóveda', async () => {
    const decoy = `${h.root}\\señuelo.txt`;
    await fs.writeFile(decoy, 'no borrar');
    h.tamper(item.id, 'vault_file', decoy);
    await expect(
      h.manager.restore(item.id, { trustHash: false }),
    ).rejects.toMatchObject({
      code: 'INVALID_ITEM',
    });
    await expect(h.manager.delete(item.id)).rejects.toMatchObject({
      code: 'INVALID_ITEM',
    });
    expect(await fs.readFile(decoy, 'utf8')).toBe('no borrar');
  });

  it('PENDING con clave equivocada y sin original: la reconciliación no destruye el blob', async () => {
    h.tamper(item.id, 'status', 'PENDING');
    h.tamper(item.id, 'key_b64', randomBytes(32).toString('base64'));
    h.manager = h.makeManager();
    await h.manager.reconcile();
    expect(h.record(item.id).status).toBe('FAILED');
    expect((await fs.readFile(item.vaultFile)).equals(pristine)).toBe(true);
  });
});

function flip(buffer: Buffer, index: number): Buffer {
  return withByte(buffer, index, buffer[index]! ^ 0x01);
}
function withByte(buffer: Buffer, index: number, value: number): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = value;
  return copy;
}

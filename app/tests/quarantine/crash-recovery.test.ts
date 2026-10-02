import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuarantineRecord } from '../../src/core/persistence/QuarantineRepository';
import { exists } from '../../src/core/quarantine/paths';
import { QuarantineHarness, sha, type Seeded } from './harness';

vi.setConfig({ testTimeout: 30_000 });

let h: QuarantineHarness;
beforeEach(async () => {
  h = new QuarantineHarness();
  await h.setup();
});
afterEach(() => h.close());

/** Reinicia la app: un gestor nuevo sobre la misma BD y bóveda, y reconciliación al iniciar. */
async function restartAndReconcile(): Promise<void> {
  h.manager = h.makeManager();
  await h.manager.reconcile();
}

/**
 * Invariante de CA-4.5 para una cuarentena interrumpida: sin PENDING, el contenido queda
 * exactamente en UN sitio (original intacto o blob verificable) y sin temporales.
 */
async function expectExactlyOneCopy(id: string, input: Seeded): Promise<void> {
  const record = h.record(id);
  expect(h.manager.list('PENDING')).toEqual([]);
  const originalOk =
    (await exists(input.path)) &&
    sha(await fs.readFile(input.path)) === input.hash;
  const blobOk =
    (await exists(record.vaultFile)) &&
    (await h.vault.verify(record).then(
      () => true,
      () => false,
    ));
  expect({ originalOk, blobOk }).not.toEqual({
    originalOk: false,
    blobOk: false,
  }); // pérdida
  expect({ originalOk, blobOk }).not.toEqual({
    originalOk: true,
    blobOk: true,
  }); // duplicado
  expect(record.status).toBe(originalOk ? 'FAILED' : 'QUARANTINED');
  expect(await exists(h.vault.path(id, true))).toBe(false);
}

// ---------------------------------------------------------------------------
// Cuarentena: estado persistido en cada frontera de los 7 pasos del plan
// ---------------------------------------------------------------------------

type QuarantineStep =
  | '4-pending-sin-blob'
  | '5a-temporal-a-medias'
  | '5b-temporal-completo'
  | '5c-publicado-y-temporal'
  | '5d-publicado-sin-tag'
  | '5e-tag-guardado'
  | '6-original-borrado';

/** Reproduce lo que QuarantineManager.isolate deja en disco y en la BD si la app muere en `step`. */
async function crashQuarantineAt(step: QuarantineStep) {
  const input = await h.seed(
    `muestra-${step}.txt`,
    Buffer.alloc(2 * 1024 * 1024 + 9, 'inofensivo '),
  );
  await h.vault.initialize();
  const id = randomUUID();
  const record: QuarantineRecord = {
    id,
    resultId: input.id,
    originalPath: input.path,
    sha256: input.hash,
    sizeBytes: input.data.length,
    vaultFile: h.vault.path(id),
    ...h.vault.key(),
    authTagB64: null,
    reason: 'Resultado DETECTED confirmado por el usuario',
    verdictSnapshot: 'DETECTED',
    status: 'PENDING',
    quarantinedAt: null,
    restoredAt: null,
    restoredTo: null,
    deletedAt: null,
    errorMessage: null,
  };
  // Paso 4: journal durable.
  h.db.transaction(() => {
    h.manager.repository.insert(record);
    h.manager.audit.append('QUARANTINE_PENDING', id, { resultId: input.id });
  });
  if (step === '4-pending-sin-blob') return { input, id };
  // Paso 5: cifrado real con la bóveda (deja el blob publicado).
  const source = await fs.open(input.path, 'r');
  const tag = await h.vault
    .encrypt(source, record)
    .finally(() => source.close());
  const blob = h.vault.path(id);
  const temp = h.vault.path(id, true);
  if (step === '5a-temporal-a-medias') {
    await fs.rename(blob, temp);
    await fs.truncate(temp, 17 + 1000);
  } else if (step === '5b-temporal-completo') {
    await fs.rename(blob, temp);
  } else if (step === '5c-publicado-y-temporal') {
    await fs.copyFile(blob, temp);
  } else if (step !== '5d-publicado-sin-tag') {
    record.authTagB64 = tag;
    h.manager.repository.update(record);
    if (step === '6-original-borrado') await fs.unlink(input.path);
  }
  return { input, id };
}

describe('cierre simulado durante la cuarentena → reconciliación al iniciar', () => {
  it.each<QuarantineStep>([
    '4-pending-sin-blob',
    '5a-temporal-a-medias',
    '5b-temporal-completo',
    '5c-publicado-y-temporal',
    '5d-publicado-sin-tag',
    '5e-tag-guardado',
  ])(
    'cierre en %s: conserva el original y no deja blob ni temporal',
    async (step) => {
      const { input, id } = await crashQuarantineAt(step);
      await restartAndReconcile();
      await expectExactlyOneCopy(id, input);
      expect(h.record(id)).toMatchObject({
        status: 'FAILED',
        errorMessage: 'RECOVERED_ORIGINAL_KEPT',
      });
      expect(await h.vaultFiles()).toEqual([]);
      expect(h.confirm).not.toHaveBeenCalled(); // recuperar nunca pide ni inicia acciones
    },
  );

  it('cierre en 6-original-borrado: completa QUARANTINED con el blob verificado', async () => {
    const { input, id } = await crashQuarantineAt('6-original-borrado');
    await restartAndReconcile();
    await expectExactlyOneCopy(id, input);
    expect(h.record(id).status).toBe('QUARANTINED');
    const restored = await h.manager.restore(id, { trustHash: false });
    expect(sha(await fs.readFile(restored.restoredTo!))).toBe(input.hash);
  });

  it('la reconciliación es idempotente: un segundo reinicio no cambia nada', async () => {
    const steps: QuarantineStep[] = [
      '5c-publicado-y-temporal',
      '6-original-borrado',
    ];
    const ids: string[] = [];
    for (const step of steps) {
      const { id } = await crashQuarantineAt(step);
      ids.push(id);
    }
    await restartAndReconcile();
    const first = ids.map((id) => h.record(id));
    const audit = h.manager.audit.list().length;
    await restartAndReconcile();
    expect(ids.map((id) => h.record(id))).toEqual(first);
    expect(h.manager.audit.list().length).toBe(audit);
  });

  it('el usuario cambia el original después del cierre (5e): no se toca su archivo nuevo ni se pierde la copia', async () => {
    const { input, id } = await crashQuarantineAt('5e-tag-guardado');
    await fs.writeFile(
      input.path,
      'El usuario editó el archivo después del cierre',
    );
    await restartAndReconcile();
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'El usuario editó el archivo después del cierre',
    );
    const record = h.record(id);
    expect(record.status).toBe('QUARANTINED');
    await expect(h.vault.verify(record)).resolves.toBeTypeOf('string');
  });

  it('el usuario borra el original después de un cierre en 4: no queda PENDING', async () => {
    const { input, id } = await crashQuarantineAt('4-pending-sin-blob');
    await fs.unlink(input.path);
    await restartAndReconcile();
    expect(h.manager.list('PENDING')).toEqual([]);
    expect(h.record(id).status).toBe('FAILED');
  });

  it('cierre "real": el proceso se cuelga tras cifrar y otro arranque reconcilia', async () => {
    const input = await h.seed('colgado.txt');
    let hang!: (reason: Error) => void;
    const encrypt = h.vault.encrypt.bind(h.vault);
    vi.spyOn(h.vault, 'encrypt').mockImplementationOnce(async (file, item) => {
      await encrypt(file, item);
      // La app "muere" aquí: nunca guarda el tag ni borra el original.
      return new Promise<string>((_resolve, reject) => {
        hang = reject;
      });
    });
    const frozen = h.manager
      .quarantine(input.id)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(hang).toBeTypeOf('function'));
    const dead = h.manager;
    const [row] = dead.list('PENDING');
    // Segundo arranque mientras el primero sigue colgado (otro proceso, misma BD).
    h.manager = h.makeManager();
    await h.manager.reconcile();
    await expectExactlyOneCopy(row!.id, input);
    // Liberar el proceso colgado solo para cerrar sus descriptores al final de la prueba.
    hang(new Error('proceso terminado'));
    await frozen;
    await dead.close();
  });
});

// ---------------------------------------------------------------------------
// Restauración y eliminación interrumpidas
// ---------------------------------------------------------------------------

type RestoreStep =
  | 'R1-pending-sin-temporal'
  | 'R2-temporal-a-medias'
  | 'R3-temporal-completo'
  | 'R4-publicado-y-temporal'
  | 'R5-publicado';

/** Ítem real en cuarentena y estado que deja restore() si la app muere en `step`. */
async function crashRestoreAt(step: RestoreStep, trust = false) {
  const input = await h.seed('restaurar.txt');
  const item = await h.manager.quarantine(input.id);
  const record = h.record(item.id);
  record.status = 'PENDING';
  record.restoredTo = input.path;
  record.errorMessage = trust ? 'RESTORE_TRUST_PENDING' : 'RESTORE_PENDING';
  h.db.transaction(() => {
    h.manager.repository.update(record);
    h.manager.audit.append('RESTORE_PENDING', record.id, {});
  });
  const temp = join(dirname(input.path), `.cybersoc-restore-${record.id}.tmp`);
  if (step === 'R2-temporal-a-medias')
    await fs.writeFile(temp, input.data.subarray(0, 10));
  if (step === 'R3-temporal-completo' || step === 'R4-publicado-y-temporal')
    await fs.writeFile(temp, input.data);
  if (step === 'R4-publicado-y-temporal') await fs.link(temp, input.path);
  if (step === 'R5-publicado') await fs.writeFile(input.path, input.data);
  return { input, id: record.id, temp };
}

describe('cierre simulado durante la restauración → reconciliación al iniciar', () => {
  it.each<RestoreStep>([
    'R1-pending-sin-temporal',
    'R2-temporal-a-medias',
    'R3-temporal-completo',
  ])(
    'cierre en %s: vuelve a QUARANTINED y no deja texto plano',
    async (step) => {
      const { input, id, temp } = await crashRestoreAt(step);
      await restartAndReconcile();
      const record = h.record(id);
      expect(record).toMatchObject({
        status: 'QUARANTINED',
        restoredTo: null,
        errorMessage: 'RESTORE_ROLLED_BACK',
      });
      expect(await exists(temp)).toBe(false);
      expect(await exists(input.path)).toBe(false);
      await expect(h.vault.verify(record)).resolves.toBeTypeOf('string');
    },
  );

  it.each<RestoreStep>(['R4-publicado-y-temporal', 'R5-publicado'])(
    'cierre en %s: completa RESTORED sin crear otra copia',
    async (step) => {
      const { input, id, temp } = await crashRestoreAt(step);
      await restartAndReconcile();
      const record = h.record(id);
      expect(record.status).toBe('RESTORED');
      expect(sha(await fs.readFile(input.path))).toBe(input.hash);
      expect(await exists(record.vaultFile)).toBe(false);
      expect(await exists(temp)).toBe(false);
      expect(
        (await fs.readdir(h.root)).filter((n) => n.includes('restored')),
      ).toEqual([]);
    },
  );

  // Regresión T4.3-B: un archivo ajeno en el destino no debe dejar un temporal
  // descifrado ni bloquear el ítem recuperable en FAILED.
  it('[HALLAZGO B] cierre en R3 y otro archivo aparece en el destino: el ítem vuelve a QUARANTINED y no queda texto plano', async () => {
    const { input, id, temp } = await crashRestoreAt('R3-temporal-completo');
    await fs.writeFile(input.path, 'Archivo distinto creado por otro programa');
    await restartAndReconcile();
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'Archivo distinto creado por otro programa',
    );
    expect(await exists(temp)).toBe(false);
    const record = h.record(id);
    expect(record.status).toBe('QUARANTINED');
    expect(record.restoredTo).toBeNull();
    const restored = await h.manager.restore(id, { trustHash: false });
    expect(restored.restoredTo).not.toBe(input.path);
    expect(sha(await fs.readFile(restored.restoredTo!))).toBe(input.hash);
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'Archivo distinto creado por otro programa',
    );
  });

  it('[HALLAZGO B] cierre en R1 y otro archivo aparece en el destino: el ítem vuelve a QUARANTINED', async () => {
    const { input, id } = await crashRestoreAt('R1-pending-sin-temporal');
    await fs.writeFile(input.path, 'Archivo distinto creado por otro programa');
    await restartAndReconcile();
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'Archivo distinto creado por otro programa',
    );
    expect(h.record(id).status).toBe('QUARANTINED');
  });

  it('rollback con confianza pendiente no añade allowlist y permite eliminar el blob', async () => {
    const { input, id, temp } = await crashRestoreAt(
      'R2-temporal-a-medias',
      true,
    );
    await fs.writeFile(input.path, 'archivo ajeno');
    await restartAndReconcile();
    expect(await exists(temp)).toBe(false);
    expect(h.record(id).status).toBe('QUARANTINED');
    expect(h.db.prepare('SELECT count(*) AS n FROM allowlist').get()?.n).toBe(
      0,
    );
    await h.manager.delete(id);
    expect(h.record(id).status).toBe('DELETED');
    expect(await fs.readFile(input.path, 'utf8')).toBe('archivo ajeno');
  });

  it('retira el temporal descifrado aunque el blob esté corrupto al reconciliar', async () => {
    const { input, id, temp } = await crashRestoreAt('R3-temporal-completo');
    await fs.writeFile(input.path, 'archivo ajeno');
    await fs.writeFile(h.record(id).vaultFile, 'blob corrupto inofensivo');
    await restartAndReconcile();
    expect(await exists(temp)).toBe(false);
    expect(h.record(id).status).toBe('FAILED');
    expect(await fs.readFile(input.path, 'utf8')).toBe('archivo ajeno');
    expect(await exists(h.record(id).vaultFile)).toBe(true);
  });

  it('el núcleo del hallazgo B, sin depender de la expectativa: nunca se sobrescribe el archivo ajeno ni se borra el blob', async () => {
    const { input, id } = await crashRestoreAt('R3-temporal-completo');
    await fs.writeFile(input.path, 'Archivo distinto creado por otro programa');
    await restartAndReconcile();
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'Archivo distinto creado por otro programa',
    );
    expect(h.manager.list('PENDING')).toEqual([]);
    await expect(h.vault.verify(h.record(id))).resolves.toBeTypeOf('string');
  });

  it('cierre durante la eliminación con el blob aún presente: completa DELETED y borra solo el blob', async () => {
    const input = await h.seed('eliminar.txt');
    const item = await h.manager.quarantine(input.id);
    await fs.writeFile(input.path, 'archivo nuevo en la ruta original');
    const record = h.record(item.id);
    record.status = 'PENDING';
    record.errorMessage = 'DELETE_PENDING';
    h.manager.repository.update(record);
    await restartAndReconcile();
    expect(h.record(item.id).status).toBe('DELETED');
    expect(await exists(item.vaultFile)).toBe(false);
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'archivo nuevo en la ruta original',
    );
  });
});

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanResultRepository } from '../../src/core/persistence/ScanResultRepository';
import { QuarantineVault } from '../../src/core/quarantine/QuarantineVault';
import { exists } from '../../src/core/quarantine/paths';
import * as originalFile from '../../src/core/quarantine/OriginalFile';
import { QuarantineHarness, sha, type Seeded } from './harness';

// Permite espiar deleteVerifiedOriginal (export ESM) sin cambiar su comportamiento real.
vi.mock('../../src/core/quarantine/OriginalFile', async (original) => ({
  ...(await original<
    typeof import('../../src/core/quarantine/OriginalFile')
  >()),
}));
vi.setConfig({ testTimeout: 30_000 });

let h: QuarantineHarness;
beforeEach(async () => {
  h = new QuarantineHarness();
  await h.setup();
});
afterEach(() => h.close());

/** Otro resultado del MISMO archivo (p. ej. escaneado dos veces), con la ruta escrita como `path`. */
let extraSeq = 1000;
function secondResult(input: Seeded, path: string): string {
  const original = new ScanResultRepository(h.db).get(input.id)!;
  const seq = extraSeq++;
  const id = `${input.id}-bis-${seq}`;
  h.db
    .prepare(
      `INSERT INTO scan_results (id, job_id, seq, path, file_name, status, sha256, size_bytes,
        scanned_at, verdict, engine_score, risk_level, ai_status)
       SELECT ?, job_id, ?, ?, file_name, status, sha256, size_bytes,
        scanned_at, verdict, engine_score, risk_level, ai_status FROM scan_results WHERE id = ?`,
    )
    .run(id, seq, path, original.id);
  return id;
}

/** Retiene la primera confirmación hasta `release()`: la operación queda "en curso". */
function holdFirstConfirmation() {
  let release!: (ok: boolean) => void;
  h.confirm.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  return {
    started: () => vi.waitFor(() => expect(release).toBeTypeOf('function')),
    release: (ok = true) => release(ok),
  };
}

/** Exactamente una copia: el blob del único ítem QUARANTINED; nada PENDING ni sobrante en la bóveda. */
async function expectSingleQuarantine(input: Seeded) {
  const items = h.manager.list();
  expect(items.filter((i) => i.status === 'PENDING')).toEqual([]);
  const active = items.filter((i) => i.status === 'QUARANTINED');
  expect(active).toHaveLength(1);
  expect(await exists(input.path)).toBe(false);
  expect(await h.vaultFiles()).toEqual([basename(active[0]!.vaultFile)]);
  return active[0]!;
}

describe('mismo gestor (una instancia de la app)', () => {
  it.each([
    ['la misma ruta', (p: string) => p],
    ['la ruta en MAYÚSCULAS', (p: string) => p.toUpperCase()],
    ['la ruta en minúsculas', (p: string) => p.toLowerCase()],
    ['la ruta con barras normales', (p: string) => p.replaceAll('\\', '/')],
  ])(
    'dos solicitudes a la vez con %s: la segunda se rechaza BUSY antes de confirmar',
    async (_name, spelling) => {
      const input = await h.seed();
      const other = secondResult(input, spelling(input.path));
      const hold = holdFirstConfirmation();
      const first = h.manager.quarantine(input.id);
      await hold.started();
      await expect(h.manager.quarantine(other)).rejects.toMatchObject({
        code: 'BUSY',
      });
      hold.release();
      await first;
      expect(h.confirm).toHaveBeenCalledTimes(1);
      await expectSingleQuarantine(input);
      expect(h.manager.audit.list(other).map((r) => r.action)).toContain(
        'QUARANTINE_REJECTED',
      );
    },
  );

  it('con un alias corto 8.3 de la carpeta: la segunda también se rechaza BUSY', async (context) => {
    const shortTemp = tmpdir();
    if ((await fs.realpath(shortTemp)) === shortTemp)
      context.skip('Este equipo no expone %TEMP% con nombre corto 8.3.');
    const input = await h.seed();
    const other = secondResult(
      input,
      join(shortTemp, basename(h.root), basename(input.path)),
    );
    const hold = holdFirstConfirmation();
    const first = h.manager.quarantine(input.id);
    await hold.started();
    await expect(h.manager.quarantine(other)).rejects.toMatchObject({
      code: 'BUSY',
    });
    hold.release();
    await first;
    await expectSingleQuarantine(input);
  });

  it('la segunda solicitud, después de terminar la primera, falla limpia: sin PENDING ni blob extra', async () => {
    const input = await h.seed();
    const other = secondResult(input, input.path);
    await h.manager.quarantine(input.id);
    await expect(h.manager.quarantine(other)).rejects.toThrow();
    await expectSingleQuarantine(input);
  });

  it('diez solicitudes simultáneas del mismo archivo: una sola cuarentena', async () => {
    const input = await h.seed();
    const ids = [
      input.id,
      ...Array.from({ length: 9 }, () => secondResult(input, input.path)),
    ];
    const results = await Promise.allSettled(
      ids.map((id) => h.manager.quarantine(id)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expectSingleQuarantine(input);
  });

  it('cancelar la primera libera la ruta: la siguiente solicitud funciona', async () => {
    const input = await h.seed();
    const hold = holdFirstConfirmation();
    const first = h.manager.quarantine(input.id);
    await hold.started();
    hold.release(false);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await h.manager.quarantine(input.id);
    await expectSingleQuarantine(input);
  });

  it('archivos distintos en paralelo no se bloquean entre sí', async () => {
    const a = await h.seed('a.txt', 'contenido A');
    const b = await h.seed('b.txt', 'contenido B');
    const [x, y] = await Promise.all([
      h.manager.quarantine(a.id),
      h.manager.quarantine(b.id),
    ]);
    expect([x.status, y.status]).toEqual(['QUARANTINED', 'QUARANTINED']);
    for (const [item, input] of [
      [x, a],
      [y, b],
    ] as const) {
      const restored = await h.manager.restore(item.id, { trustHash: false });
      expect(sha(await fs.readFile(restored.restoredTo!))).toBe(input.hash);
    }
  });

  it('reconcile mientras hay una operación activa se rechaza BUSY', async () => {
    const input = await h.seed();
    const hold = holdFirstConfirmation();
    const first = h.manager.quarantine(input.id);
    await hold.started();
    await expect(h.manager.reconcile()).rejects.toMatchObject({ code: 'BUSY' });
    hold.release();
    await first;
    await expectSingleQuarantine(input);
  });
});

describe('dos instancias de la app (dos gestores sobre la misma BD)', () => {
  // La app no llama a app.requestSingleInstanceLock(): el usuario puede abrirla dos veces.
  // El Map de operaciones es de cada instancia, así que no las coordina entre sí.
  // B se detiene en `pause` y, mientras tanto, A completa TODA la cuarentena del mismo archivo.
  async function raceTwoInstances(pause: 'tras-cifrar' | 'antes-de-borrar') {
    const input = await h.seed(
      'compartido.txt',
      Buffer.alloc(256 * 1024, 'inofensivo '),
    );
    const vaultB = new QuarantineVault(h.vault.root);
    const managerB = h.makeManager(vaultB);
    let aDone!: () => void;
    const aFinished = new Promise<void>((resolve) => {
      aDone = resolve;
    });
    let bPaused = false;
    if (pause === 'tras-cifrar') {
      // B ya insertó su PENDING y tiene su blob publicado.
      const encryptB = vaultB.encrypt.bind(vaultB);
      vi.spyOn(vaultB, 'encrypt').mockImplementation(async (file, item) => {
        const tag = await encryptB(file, item);
        bPaused = true;
        await aFinished;
        return tag;
      });
    } else {
      // B ya revalidó la ruta y el hash: solo le falta borrar el original.
      const realDelete = originalFile.deleteVerifiedOriginal;
      let calls = 0;
      vi.spyOn(originalFile, 'deleteVerifiedOriginal').mockImplementation(
        async (path, hash) => {
          if (calls++ === 0) {
            bPaused = true;
            await aFinished;
          }
          return realDelete(path, hash);
        },
      );
    }
    const b = managerB.quarantine(input.id).then(
      () => 'ok' as const,
      (error: { code?: string }) => error.code ?? 'error',
    );
    await vi.waitFor(() => expect(bPaused).toBe(true));
    await h.manager.quarantine(input.id); // instancia A: termina bien
    aDone();
    const outcomeB = await b;
    await managerB.close();
    // Se cierran ambas instancias y la app arranca de nuevo.
    h.manager = h.makeManager();
    await h.manager.reconcile();
    return { input, outcomeB };
  }

  it.each(['tras-cifrar', 'antes-de-borrar'] as const)(
    'B detenida %s mientras A termina: B falla limpia y no duplica (una cuarentena, sin PENDING ni blobs sobrantes)',
    async (pause) => {
      const { input, outcomeB } = await raceTwoInstances(pause);
      expect(outcomeB).not.toBe('ok');
      const kept = await expectSingleQuarantine(input);
      const restored = await h.manager.restore(kept.id, { trustHash: false });
      expect(sha(await fs.readFile(restored.restoredTo!))).toBe(input.hash);
      expect(h.manager.list('FAILED')).toHaveLength(1);
    },
  );
});

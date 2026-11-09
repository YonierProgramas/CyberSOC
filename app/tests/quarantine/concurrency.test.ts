import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanResultRepository } from '../../src/core/persistence/ScanResultRepository';
import { QuarantineVault } from '../../src/core/quarantine/QuarantineVault';
import { exists } from '../../src/core/quarantine/paths';
import * as originalFile from '../../src/core/quarantine/OriginalFile';
import { QuarantineHarness, sha, type Seeded } from './harness';

// Allows spying on deleteVerifiedOriginal (ESM export) without changing its real behavior.
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

/** Another result of the SAME file (e.g. scanned twice), with the path written as `path`. */
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

/** Holds the first confirmation until `release()`: the operation stays "in progress". */
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

/** Exactly one copy: the blob of the only QUARANTINED item; nothing PENDING or left over in the vault. */
async function expectSingleQuarantine(input: Seeded) {
  const items = h.manager.list();
  expect(items.filter((i) => i.status === 'PENDING')).toEqual([]);
  const active = items.filter((i) => i.status === 'QUARANTINED');
  expect(active).toHaveLength(1);
  expect(await exists(input.path)).toBe(false);
  expect(await h.vaultFiles()).toEqual([basename(active[0]!.vaultFile)]);
  return active[0]!;
}

describe('same manager (one app instance)', () => {
  it.each([
    ['la misma ruta', (p: string) => p],
    ['la ruta en MAYÚSCULAS', (p: string) => p.toUpperCase()],
    ['la ruta en minúsculas', (p: string) => p.toLowerCase()],
    ['la ruta con barras normales', (p: string) => p.replaceAll('\\', '/')],
  ])(
    'two requests at once with %s: the second is rejected BUSY before confirming',
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

  it('with an 8.3 short alias of the folder: the second is also rejected BUSY', async (context) => {
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

  it('the second request, after the first ends, fails cleanly: no PENDING or extra blob', async () => {
    const input = await h.seed();
    const other = secondResult(input, input.path);
    await h.manager.quarantine(input.id);
    await expect(h.manager.quarantine(other)).rejects.toThrow();
    await expectSingleQuarantine(input);
  });

  it('ten simultaneous requests for the same file: a single quarantine', async () => {
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

  it('cancelling the first releases the path: the next request works', async () => {
    const input = await h.seed();
    const hold = holdFirstConfirmation();
    const first = h.manager.quarantine(input.id);
    await hold.started();
    hold.release(false);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await h.manager.quarantine(input.id);
    await expectSingleQuarantine(input);
  });

  it('different files in parallel do not block each other', async () => {
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

  it('reconcile while an operation is active is rejected BUSY', async () => {
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

describe('two app instances (two managers on the same DB)', () => {
  // The app does not call app.requestSingleInstanceLock(): the user can open it twice.
  // The operations Map belongs to each instance, so it does not coordinate them.
  // B stops at `pause` and meanwhile A completes the WHOLE quarantine of the same file.
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
      // B has already inserted its PENDING and has its blob published.
      const encryptB = vaultB.encrypt.bind(vaultB);
      vi.spyOn(vaultB, 'encrypt').mockImplementation(async (file, item) => {
        const tag = await encryptB(file, item);
        bPaused = true;
        await aFinished;
        return tag;
      });
    } else {
      // B has already revalidated the path and hash: it only has to delete the original.
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
    // Both instances are closed and the app starts again.
    h.manager = h.makeManager();
    await h.manager.reconcile();
    return { input, outcomeB };
  }

  it.each(['tras-cifrar', 'antes-de-borrar'] as const)(
    'B stopped %s while A finishes: B fails cleanly and does not duplicate (one quarantine, no PENDING or leftover blobs)',
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

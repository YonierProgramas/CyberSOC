import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import {
  QuarantineRepository,
  type QuarantineRecord,
} from '../src/core/persistence/QuarantineRepository';
import { QuarantineError, ProtectedPaths } from '../src/core/quarantine/paths';
import { QuarantineManager } from '../src/core/quarantine/QuarantineManager';
import { QuarantineVault } from '../src/core/quarantine/QuarantineVault';
import {
  QuarantineUIConfirmation,
  registerQuarantineIpc,
} from '../src/main/ipc/quarantine.ipc';
import { createQuarantineSchemas } from '../src/shared/ipc';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: electron, dialog: electron }));
const url = 'file:///app/index.html';
const frame = { url };
const webContents = {
  mainFrame: frame,
  isDestroyed: vi.fn(() => false),
  send: vi.fn(),
};
const window = {
  webContents,
  isDestroyed: vi.fn(() => false),
} as unknown as BrowserWindow;
const event = {
  sender: webContents,
  senderFrame: frame,
} as unknown as IpcMainInvokeEvent;
const record: QuarantineRecord = {
  id: 'q1',
  resultId: 'r1',
  originalPath: 'C:\\prueba.txt',
  sha256: 'a'.repeat(64),
  sizeBytes: 20,
  vaultFile: 'private-vault-path',
  keyB64: 'private-key',
  ivB64: 'private-iv',
  authTagB64: 'private-tag',
  reason: 'Prueba',
  verdictSnapshot: 'DETECTED',
  status: 'QUARANTINED',
  quarantinedAt: '2026-10-02',
  restoredAt: null,
  restoredTo: null,
  deletedAt: null,
  errorMessage: null,
};
let db: Database;
let gate: QuarantineUIConfirmation;
let service: {
  list: ReturnType<typeof vi.fn<() => QuarantineRecord[]>>;
  quarantine: ReturnType<
    typeof vi.fn<(id: string) => Promise<QuarantineRecord>>
  >;
  restore: ReturnType<
    typeof vi.fn<
      (
        id: string,
        opts: { trustHash: boolean; targetPath?: string },
      ) => Promise<QuarantineRecord>
    >
  >;
  delete: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
};
let stop: () => void;
function call(
  channel: string,
  args: unknown[] = [],
  sender = event,
): Promise<unknown> {
  return electron.handle.mock.calls.find(
    ([name]) => name === `quarantine:${channel}`,
  )![1](sender, ...args);
}
beforeEach(() => {
  vi.clearAllMocks();
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  frame.url = url;
  webContents.isDestroyed.mockReturnValue(false);
  db = new Database(':memory:');
  new MigrationRunner(db).run();
  new ScanJobRepository(db).create({
    id: 'j1',
    targetPath: 'C:\\prueba.txt',
    targetKind: 'FILE',
  });
  new ScanResultRepository(db).insertResult({
    id: 'r1',
    jobId: 'j1',
    seq: 1,
    path: 'C:\\prueba.txt',
    fileName: 'prueba.txt',
    status: 'SCANNED',
  });
  new QuarantineRepository(db).insert(record);
  gate = new QuarantineUIConfirmation();
  service = {
    list: vi.fn(() => [record]),
    quarantine: vi.fn(async () => record),
    restore: vi.fn(async () => ({ ...record, status: 'RESTORED' })),
    delete: vi.fn(async () => {}),
  };
  stop = registerQuarantineIpc(() => window, url, service, db, gate);
});
afterEach(() => {
  stop();
  db.close();
});

it('registra cuatro métodos, valida salidas y nunca entrega claves ni la ruta de la bóveda', async () => {
  expect(electron.handle.mock.calls.map(([channel]) => channel)).toEqual([
    'quarantine:list',
    'quarantine:quarantine',
    'quarantine:restore',
    'quarantine:delete',
  ]);
  const list = await call('list');
  expect(list).toEqual([
    expect.objectContaining({ id: 'q1', status: 'QUARANTINED' }),
  ]);
  expect(JSON.stringify(list)).not.toContain('private-');
  for (const status of [
    'PENDING',
    'QUARANTINED',
    'RESTORED',
    'DELETED',
    'FAILED',
  ]) {
    await call('list', [{ status }]);
    expect(service.list).toHaveBeenLastCalledWith(status);
  }
  await call('list', [undefined]);
  expect(service.list).toHaveBeenLastCalledWith(undefined);
  const item = await call('quarantine', ['r1']);
  expect(createQuarantineSchemas(z).item.safeParse(item).success).toBe(true);
  expect(JSON.stringify(item)).not.toContain('private-');
  expect(service.quarantine).toHaveBeenCalledExactlyOnceWith('r1');
  await expect(
    call('restore', ['q1', { trustHash: true, targetPath: 'C:\\otra.txt' }]),
  ).resolves.toMatchObject({ status: 'RESTORED' });
  expect(service.restore).toHaveBeenCalledExactlyOnceWith('q1', {
    trustHash: true,
    targetPath: 'C:\\otra.txt',
  });
  await expect(call('delete', ['q1'])).resolves.toBeUndefined();
  expect(service.delete).toHaveBeenCalledExactlyOnceWith('q1');
  expect(webContents.send.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [
      'quarantine:changed',
      { itemId: 'q1', resultId: 'r1' },
    ]),
  );
});

it.each([
  ['list', [{ status: 'UNKNOWN' }]],
  ['list', [{ extra: true }]],
  ['list', [{}, {}]],
  ['list', [null]],
  ['quarantine', []],
  ['quarantine', ['']],
  ['quarantine', [123]],
  ['quarantine', [' r1']],
  ['quarantine', ['r1', 'extra']],
  ['restore', ['q1']],
  ['restore', ['q1', {}]],
  ['restore', ['q1', { trustHash: 'false' }]],
  ['restore', ['q1', { trustHash: false, extra: true }]],
  ['restore', ['q1', { trustHash: false, targetPath: '' }]],
  ['restore', ['q1', { trustHash: false, targetPath: 'C:\\a\0b' }]],
  ['restore', ['q1', { trustHash: false }, true]],
  ['delete', []],
  ['delete', [{}]],
  ['delete', ['q1', true]],
] as [string, unknown[]][])(
  'rechaza argumentos inválidos: %s %j',
  async (channel, args) => {
    await expect(call(channel, args)).rejects.toThrow('QUARANTINE_FAILED');
    for (const method of Object.values(service))
      expect(method).not.toHaveBeenCalled();
    expect(webContents.send).not.toHaveBeenCalled();
  },
);

it.each(['quarantine', 'restore', 'delete'])(
  'comprueba existencia antes de %s',
  async (channel) => {
    await expect(
      call(
        channel,
        channel === 'restore' ? ['missing', { trustHash: false }] : ['missing'],
      ),
    ).rejects.toThrow('NOT_FOUND');
    for (const method of Object.values(service))
      expect(method).not.toHaveBeenCalled();
    expect(webContents.send).not.toHaveBeenCalled();
  },
);

it.each(['list', 'quarantine', 'restore', 'delete'])(
  'rechaza ventanas ajenas y subframes en %s',
  async (channel) => {
    const args =
      channel === 'list'
        ? []
        : channel === 'restore'
          ? ['q1', { trustHash: false }]
          : [channel === 'quarantine' ? 'r1' : 'q1'];
    for (const sender of [
      { sender: {}, senderFrame: frame },
      { sender: webContents, senderFrame: { url } },
    ])
      await expect(
        call(channel, args, sender as unknown as IpcMainInvokeEvent),
      ).rejects.toThrow('QUARANTINE_FAILED');
    frame.url = 'https://otro.example';
    await expect(call(channel, args)).rejects.toThrow('QUARANTINE_FAILED');
    frame.url = url;
    webContents.isDestroyed.mockReturnValue(true);
    await expect(call(channel, args)).rejects.toThrow('QUARANTINE_FAILED');
    for (const method of Object.values(service))
      expect(method).not.toHaveBeenCalled();
  },
);

it('limita confirmación al tipo de operación autorizado y la revoca al terminar', async () => {
  const request = {
    action: 'QUARANTINE',
    path: record.originalPath,
    verdict: 'DETECTED',
  } as const;
  expect(await gate.confirm(request)).toBe(false);
  service.quarantine.mockImplementationOnce(async () => {
    expect(await gate.confirm(request)).toBe(true);
    expect(await gate.confirm({ ...request, action: 'DELETE' })).toBe(false);
    return record;
  });
  service.restore.mockImplementationOnce(async () => {
    expect(await gate.confirm({ ...request, action: 'RESTORE' })).toBe(true);
    expect(await gate.confirm({ ...request, action: 'RESTORE_DETECTED' })).toBe(
      true,
    );
    expect(await gate.confirm(request)).toBe(false);
    return record;
  });
  await call('quarantine', ['r1']);
  await call('restore', ['q1', { trustHash: false }]);
  expect(await gate.confirm(request)).toBe(false);
});

it('aísla contextos concurrentes y revoca callbacks tardíos incluso tras un error', async () => {
  let late!: () => Promise<boolean>;
  const request = { action: 'DELETE', path: 'x', verdict: 'DETECTED' } as const;
  const pending = gate.run('DELETE', async () => {
    const resume = AsyncLocalStorage.snapshot();
    late = () => resume(() => gate.confirm(request));
    await Promise.resolve();
    expect(await gate.confirm(request)).toBe(true);
    throw new Error('expected');
  });
  await gate.run('RESTORE', async () => {
    expect(await gate.confirm(request)).toBe(false);
  });
  await expect(pending).rejects.toThrow('expected');
  expect(await late()).toBe(false);
});

it('enmascara errores internos y avisa que se debe recargar la lista tras un fallo', async () => {
  service.quarantine.mockRejectedValueOnce(
    new Error('private-key / internal trace'),
  );
  await expect(call('quarantine', ['r1'])).rejects.toThrow(
    /^No se pudo completar la operación de cuarentena \(QUARANTINE_FAILED\)\.$/,
  );
  expect(webContents.send).toHaveBeenLastCalledWith('quarantine:changed', {
    itemId: null,
    resultId: 'r1',
  });
  service.delete.mockRejectedValueOnce(
    new QuarantineError('BUSY', 'private-key'),
  );
  await expect(call('delete', ['q1'])).rejects.toThrow('(BUSY)');
});

it.each(['navigate', 'close', 'dispose'])(
  'no entrega respuesta ni evento después de %s',
  async (action) => {
    let finish!: (item: QuarantineRecord) => void;
    service.quarantine.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = call('quarantine', ['r1']);
    if (action === 'navigate') frame.url = 'https://otro.example';
    if (action === 'close') webContents.isDestroyed.mockReturnValue(true);
    if (action === 'dispose') stop();
    finish(record);
    await expect(pending).rejects.toThrow('QUARANTINE_FAILED');
    expect(webContents.send).not.toHaveBeenCalled();
  },
);

it('retira handlers una sola vez y rechaza una referencia antigua', async () => {
  stop();
  stop();
  expect(electron.removeHandler).toHaveBeenCalledTimes(4);
  await expect(call('list')).rejects.toThrow('QUARANTINE_FAILED');
  expect(service.list).not.toHaveBeenCalled();
});

it('rechaza respuestas que incumplen el contrato sin filtrar el error de Zod', async () => {
  service.list.mockReturnValueOnce([
    { ...record, sha256: 'private-malformed' },
  ]);
  await expect(call('list')).rejects.toThrow('QUARANTINE_FAILED');
});

it('IPC → gestor real → SQLite: aísla, restaura con hash idéntico y elimina solo el blob', async () => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'cybersoc-ipc-'));
  const path = join(root, 'inofensivo.txt');
  const bytes = Buffer.from('Fixture de texto inofensivo para IPC.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const vault = new QuarantineVault(join(root, 'vault'));
  const manager = new QuarantineManager({
    database: db,
    vault,
    protectedPaths: new ProtectedPaths([vault.root]),
    confirm: gate.confirm,
  });
  try {
    await writeFile(path, bytes);
    new ScanResultRepository(db).insertResult({
      id: 'real',
      jobId: 'j1',
      seq: 2,
      path,
      fileName: 'inofensivo.txt',
      status: 'SCANNED',
      sha256: hash,
      sizeBytes: bytes.length,
      verdict: 'DETECTED',
    });
    // La instancia usada por IPC no permite aislar archivos fuera de una petición confirmada.
    await expect(manager.quarantine('real')).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    stop();
    electron.handle.mockClear();
    stop = registerQuarantineIpc(() => window, url, manager, db, gate);
    const schemas = createQuarantineSchemas(z);
    const item = schemas.item.parse(await call('quarantine', ['real']));
    expect(item.status).toBe('QUARANTINED');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(manager.repository.get(item.id)?.keyB64).toBeTruthy();
    expect(JSON.stringify(item)).not.toContain('keyB64');
    // El gestor conserva la defensa contra traversal aun después de validar el tipo en IPC.
    await expect(
      call('restore', [
        item.id,
        { trustHash: false, targetPath: root + '/../../escape.txt' },
      ]),
    ).rejects.toThrow();
    const restored = schemas.item.parse(
      await call('restore', [item.id, { trustHash: false }]),
    );
    expect(restored.status).toBe('RESTORED');
    expect(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ).toBe(hash);
    const second = schemas.item.parse(await call('quarantine', ['real']));
    await call('delete', [second.id]);
    expect(manager.repository.get(second.id)?.status).toBe('DELETED');
    await expect(readFile(vault.path(second.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      db.prepare('SELECT count(*) AS n FROM audit_log').get()?.n,
    ).toBeGreaterThan(0);
    expect(await call('list', [{ status: 'DELETED' }])).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
  } finally {
    await manager.close();
    // Solo se borra el directorio temporal creado en esta prueba.
    expect(dirname(root)).toBe(temp);
    expect(basename(root)).toMatch(/^cybersoc-ipc-/);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it.each(['QUARANTINE', 'RESTORE', 'DELETE'] as const)(
  'H1: un contexto IPC válido no sustituye el permiso nativo para %s',
  async (action) => {
    electron.showMessageBox.mockResolvedValue({ response: 0 });
    expect(
      await gate.run(action, () =>
        gate.confirm({
          action,
          path: record.originalPath,
          verdict: 'DETECTED',
        }),
      ),
    ).toBe(false);
    expect(electron.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        buttons: expect.arrayContaining(['Cancelar']),
      }),
    );
  },
);

it('H1: restaurar DETECTED requiere dos decisiones nativas independientes', async () => {
  electron.showMessageBox
    .mockResolvedValueOnce({ response: 1 })
    .mockResolvedValueOnce({ response: 0 });
  const responses = await gate.run('RESTORE', async () => [
    await gate.confirm({
      action: 'RESTORE',
      path: record.originalPath,
      verdict: 'DETECTED',
      trustHash: true,
    }),
    await gate.confirm({
      action: 'RESTORE_DETECTED',
      path: record.originalPath,
      verdict: 'DETECTED',
      trustHash: true,
    }),
  ]);
  expect(responses).toEqual([true, false]);
  expect(electron.showMessageBox).toHaveBeenCalledTimes(2);
  expect(electron.showMessageBox.mock.calls[1]![0]).toMatchObject({
    title: expect.stringContaining('detectado'),
    detail: expect.stringContaining('SHA-256'),
  });
});

it('H1: fallo del diálogo nunca autoriza la operación', async () => {
  electron.showMessageBox.mockRejectedValueOnce(
    new Error('native dialog unavailable'),
  );
  await expect(
    gate.run('DELETE', () =>
      gate.confirm({
        action: 'DELETE',
        path: record.originalPath,
        verdict: 'DETECTED',
      }),
    ),
  ).rejects.toThrow();
});

it.each(['navigate', 'close', 'dispose'] as const)(
  'H1: revoca la petición durante el diálogo nativo al ocurrir %s',
  async (reason) => {
    let answer!: (response: { response: number }) => void;
    electron.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const effect = vi.fn();
    service.quarantine.mockImplementationOnce(async () => {
      const approved = await gate.confirm({
        action: 'QUARANTINE',
        path: record.originalPath,
        verdict: 'DETECTED',
      });
      if (!approved) throw new QuarantineError('CANCELLED', '');
      effect();
      return record;
    });
    const pending = call('quarantine', ['r1']);
    // Instalar el observador antes de rechazar para evitar promesas sin manejar.
    const outcome = pending.then(
      () => false,
      () => true,
    );
    await vi.waitFor(() =>
      expect(electron.showMessageBox).toHaveBeenCalledTimes(1),
    );
    if (reason === 'navigate') frame.url = 'https://otro.example';
    if (reason === 'close') webContents.isDestroyed.mockReturnValue(true);
    if (reason === 'dispose') stop();
    answer({ response: 1 });
    expect(await outcome).toBe(true);
    expect(effect).not.toHaveBeenCalled();
  },
);

it.each(['quarantine', 'restore', 'restore-detected', 'delete'] as const)(
  'H1: cancelar %s desde IPC conserva archivos, blob, veredictos y allowlist',
  async (operation) => {
    const temp = await realpath(tmpdir());
    const root = await mkdtemp(join(temp, 'cybersoc-ipc-h1-'));
    const path = join(root, 'benigno.txt');
    const bytes = Buffer.from('Texto benigno para regresión H1.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const vault = new QuarantineVault(join(root, 'vault'));
    const manager = new QuarantineManager({
      database: db,
      vault,
      protectedPaths: new ProtectedPaths([vault.root]),
      confirm: gate.confirm,
    });
    stop();
    electron.handle.mockClear();
    stop = registerQuarantineIpc(() => window, url, manager, db, gate);
    try {
      await writeFile(path, bytes);
      new ScanResultRepository(db).insertResult({
        id: 'h1',
        jobId: 'j1',
        seq: 2,
        path,
        fileName: 'benigno.txt',
        status: 'SCANNED',
        sha256: hash,
        sizeBytes: bytes.length,
        verdict: 'DETECTED',
      });
      let itemId: string | null = null;
      let blob: Buffer | null = null;
      if (operation !== 'quarantine') {
        const item = createQuarantineSchemas(z).item.parse(
          await call('quarantine', ['h1']),
        );
        itemId = item.id;
        blob = await readFile(vault.path(itemId));
      }
      const snapshot = () =>
        JSON.stringify(
          ['scan_jobs', 'scan_results', 'quarantine_items', 'allowlist'].map(
            (table) =>
              db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(),
          ),
        );
      const before = snapshot();
      electron.showMessageBox.mockClear();
      electron.showMessageBox.mockResolvedValue({ response: 0 });
      if (operation === 'restore-detected')
        electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
      const pending =
        operation === 'quarantine'
          ? call('quarantine', ['h1'])
          : operation === 'delete'
            ? call('delete', [itemId])
            : call('restore', [itemId, { trustHash: true }]);
      await expect(pending).rejects.toThrow('CANCELLED');
      expect(snapshot()).toBe(before);
      expect(manager.allowlist.has(hash)).toBe(false);
      expect(electron.showMessageBox).toHaveBeenCalledTimes(
        operation === 'restore-detected' ? 2 : 1,
      );
      if (itemId) {
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(vault.path(itemId))).toEqual(blob);
      } else expect(await readFile(path)).toEqual(bytes);
      expect(
        manager.audit.list().some((row) => row.action.endsWith('_FAILED')),
      ).toBe(true);
    } finally {
      await manager.close();
      expect(dirname(root)).toBe(temp);
      expect(basename(root)).toMatch(/^cybersoc-ipc-h1-/);
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

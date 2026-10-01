import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { RiskAssessmentRepository } from '../src/core/persistence/RiskAssessmentRepository';
import {
  QuarantineManager,
  type Confirmation,
} from '../src/core/quarantine/QuarantineManager';
import { QuarantineVault } from '../src/core/quarantine/QuarantineVault';
import {
  ProtectedPaths,
  exists,
  validatePath,
} from '../src/core/quarantine/paths';
import { decideRisk } from '../src/core/risk/RiskPolicy';
import { AIAnalysisStore } from '../src/core/ai/AIAnalysisStore';
import * as originalFile from '../src/core/quarantine/OriginalFile';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));
vi.mock('../src/core/quarantine/OriginalFile', async (original) => ({
  ...(await original<typeof import('../src/core/quarantine/OriginalFile')>()),
}));
vi.setConfig({ testTimeout: 20_000 });

const sha = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
let root: string,
  db: Database,
  vault: QuarantineVault,
  manager: QuarantineManager;
let confirm: ReturnType<
  typeof vi.fn<(request: Confirmation) => Promise<boolean>>
>;
let seq = 0;
function makeManager() {
  return new QuarantineManager({
    database: db,
    vault,
    confirm,
    protectedPaths: new ProtectedPaths([join(root, 'protected'), vault.root]),
  });
}
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'cybersoc-quarantine-')),
  );
  db = new Database(join(root, 'test.db'));
  new MigrationRunner(db).run();
  new ScanJobRepository(db).create({
    id: 'job',
    targetPath: root,
    targetKind: 'FOLDER',
  });
  vault = new QuarantineVault(join(root, 'vault'));
  confirm = vi.fn(async () => true);
  manager = makeManager();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await manager.close();
  db.close();
  // Solo el directorio creado por ESTE test; nunca corpus ni archivos del usuario.
  await fs.rm(root, { recursive: true, force: true });
});
async function seed(
  name = 'texto.txt',
  data: string | Buffer = 'Texto de prueba inofensivo.\n',
) {
  const path = join(root, name);
  await fs.writeFile(path, data);
  const id = `result-${seq++}`;
  const decision = decideRisk({ verdict: 'DETECTED', score: 100 });
  new ScanResultRepository(db).insertComplete({
    result: {
      id,
      jobId: 'job',
      seq,
      path,
      fileName: basename(path),
      status: 'SCANNED',
      sha256: sha(data),
      sizeBytes: Buffer.byteLength(data),
    },
    evidence: [],
    layers: [],
    assessment: {
      engineVerdict: decision.engineVerdict,
      engineScore: decision.engineScore,
      finalVerdict: decision.finalVerdict,
      finalLevel: decision.finalLevel,
      reviewRequired: decision.reviewRequired,
      origin: decision.origin,
      policyVersion: decision.policyVersion,
      traceJson: JSON.stringify(decision.trace),
    },
  });
  return { id, path, hash: sha(data) };
}

it('ciclo completo: hash idéntico, CSQ1 neutralizado, confirmaciones y auditoría', async () => {
  const input = await seed(
    'inofensivo.txt',
    Buffer.alloc(3 * 1024 * 1024 + 47, 65),
  );
  const item = await manager.quarantine(input.id);
  expect(await exists(input.path)).toBe(false);
  const encrypted = await fs.readFile(item.vaultFile);
  expect(encrypted.subarray(0, 5)).toEqual(Buffer.from([67, 83, 81, 49, 1]));
  expect(sha(encrypted)).not.toBe(input.hash);
  expect(item).not.toHaveProperty('keyB64');
  expect(item.status).toBe('QUARANTINED');
  const restored = await manager.restore(item.id, { trustHash: true });
  expect(restored.status).toBe('RESTORED');
  expect(await exists(item.vaultFile)).toBe(false);
  const after = sha(await fs.readFile(restored.restoredTo!));
  expect(after).toBe(input.hash);
  expect(manager.allowlist.has(input.hash)).toBe(true);
  expect(new RiskAssessmentRepository(db).get(input.id)).toMatchObject({
    finalVerdict: 'CLEAN',
    origin: 'USER_ALLOWLIST',
    policyVersion: '3',
    engineVerdict: 'DETECTED',
  });
  expect(confirm.mock.calls.map(([r]) => r.action)).toEqual([
    'QUARANTINE',
    'RESTORE',
    'RESTORE_DETECTED',
  ]);
  const actions = manager.audit.list().map((r) => r.action);
  expect(actions).toEqual([
    'QUARANTINE_PENDING',
    'QUARANTINE',
    'RESTORE_PENDING',
    'ALLOWLIST_ADD',
    'RESTORE',
  ]);
  expect(JSON.stringify(manager.audit.list())).not.toContain(
    manager.repository.get(item.id)!.keyB64,
  );
  console.log(
    `CUARENTENA_CICLO antes=${input.hash} despues=${after} iguales=true original_aislado=true blob=CSQ1 estado=RESTORED`,
  );
});

it('no actúa sin confirmación y no crea PENDING', async () => {
  const input = await seed();
  confirm.mockResolvedValue(false);
  await expect(manager.quarantine(input.id)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  expect(await exists(input.path)).toBe(true);
  expect(manager.list()).toEqual([]);
  expect(manager.audit.list().at(-1)?.action).toBe('QUARANTINE_FAILED');
});

it('archivo vacío: GCM autentica también cero bytes y cada ítem usa su propia clave', async () => {
  const a = await seed('empty-a.txt', '');
  const b = await seed('empty-b.txt', '');
  const first = await manager.quarantine(a.id);
  const second = await manager.quarantine(b.id);
  const secretA = manager.repository.get(first.id)!;
  const secretB = manager.repository.get(second.id)!;
  expect(secretA.keyB64).not.toBe(secretB.keyB64);
  expect(secretA.ivB64).not.toBe(secretB.ivB64);
  await manager.restore(first.id, { trustHash: false });
  expect((await fs.stat(a.path)).size).toBe(0);
});

it('denegar la segunda confirmación de DETECTED conserva cuarentena y no añade confianza', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    manager.restore(item.id, { trustHash: true }),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
  expect(manager.allowlist.has(input.hash)).toBe(false);
  expect(await exists(input.path)).toBe(false);
  expect(await exists(item.vaultFile)).toBe(true);
});

it('delete cancelado conserva el blob y el registro', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  confirm.mockResolvedValue(false);
  await expect(manager.delete(item.id)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
  expect(await exists(item.vaultFile)).toBe(true);
  expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
});
it('aborta si el archivo cambió después del escaneo', async () => {
  const input = await seed();
  await fs.writeFile(input.path, 'Contenido cambiado');
  await expect(manager.quarantine(input.id)).rejects.toMatchObject({
    code: 'FILE_CHANGED',
  });
  expect(manager.list()).toEqual([]);
  expect(await fs.readFile(input.path, 'utf8')).toBe('Contenido cambiado');
});
it('aborta si el original cambia durante el cifrado; no borra el reemplazo', async () => {
  const input = await seed();
  const encrypt = vault.encrypt.bind(vault);
  vi.spyOn(vault, 'encrypt').mockImplementation(async (file, item) => {
    const tag = await encrypt(file, item);
    await fs.writeFile(input.path, 'Cambio posterior a la copia');
    return tag;
  });
  await expect(manager.quarantine(input.id)).rejects.toMatchObject({
    code: 'FILE_CHANGED',
  });
  expect(manager.list()[0]?.status).toBe('FAILED');
  expect(await fs.readdir(vault.root)).toEqual([]);
  expect(await fs.readFile(input.path, 'utf8')).toBe(
    'Cambio posterior a la copia',
  );
});
it('falla antes de borrar si el temporal cifrado no supera la verificación', async () => {
  const input = await seed();
  vi.spyOn(vault, 'verify').mockRejectedValue(new Error('corrupción simulada'));
  await expect(manager.quarantine(input.id)).rejects.toThrow('corrupción');
  expect(await exists(input.path)).toBe(true);
  expect(manager.list()[0]?.status).toBe('FAILED');
  expect(await fs.readdir(vault.root)).toEqual([]);
});
it('original bloqueado: FAILED sin blob; conserva el original (fallo de borrado)', async () => {
  const input = await seed();
  vi.spyOn(originalFile, 'deleteVerifiedOriginal').mockRejectedValue(
    Object.assign(new Error('bloqueado'), { code: 'EPERM' }),
  );
  await expect(manager.quarantine(input.id)).rejects.toMatchObject({
    code: 'EPERM',
  });
  expect(manager.list()[0]?.status).toBe('FAILED');
  expect(await exists(input.path)).toBe(true);
  expect(await fs.readdir(vault.root)).toEqual([]);
});

it('borrado sin acuse: conserva el blob y PENDING para reconciliar al reiniciar', async () => {
  const input = await seed();
  vi.spyOn(originalFile, 'deleteVerifiedOriginal').mockImplementation(
    async (path) => {
      await fs.unlink(path);
      throw Object.assign(new Error('helper interrumpido'), {
        code: 'DELETE_UNCERTAIN',
      });
    },
  );
  await expect(manager.quarantine(input.id)).rejects.toMatchObject({
    code: 'DELETE_UNCERTAIN',
  });
  const item = manager.list()[0]!;
  expect(item.status).toBe('PENDING');
  expect(await exists(item.vaultFile)).toBe(true);
  expect(await exists(input.path)).toBe(false);
  manager = makeManager();
  await manager.reconcile();
  expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
});

it.skipIf(process.platform !== 'win32')(
  'Windows revalida el hash por handle incluso tras la última comprobación de Node',
  async () => {
    const input = await seed();
    const verifiedDelete = originalFile.deleteVerifiedOriginal;
    vi.spyOn(originalFile, 'deleteVerifiedOriginal').mockImplementation(
      async (path, hash) => {
        await fs.writeFile(path, 'Cambio en la frontera de borrado');
        return verifiedDelete(path, hash);
      },
    );
    await expect(manager.quarantine(input.id)).rejects.toMatchObject({
      code: 'FILE_CHANGED',
    });
    expect(await fs.readFile(input.path, 'utf8')).toBe(
      'Cambio en la frontera de borrado',
    );
    expect(await fs.readdir(vault.root)).toEqual([]);
    expect(manager.list()[0]?.status).toBe('FAILED');
  },
);
it.skipIf(process.platform !== 'win32')(
  'original bloqueado realmente por Windows: FAILED sin blob',
  async () => {
    const input = await seed();
    // FileShare.Read permite verificar/cifrar, pero niega Delete: fuerza el fallo del paso 6.
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$f=[System.IO.File]::Open($env:CYBERSOC_TEST_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); Write-Output READY; try { [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }',
      ],
      {
        windowsHide: true,
        env: { ...process.env, CYBERSOC_TEST_LOCK_PATH: input.path },
        stdio: 'pipe',
      },
    );
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('No se abrió el bloqueo');
        }),
      ]);
      await expect(manager.quarantine(input.id)).rejects.toThrow();
      expect(manager.list()[0]?.status).toBe('FAILED');
      expect(await fs.readdir(vault.root)).toEqual([]);
      expect(await exists(input.path)).toBe(true);
    } finally {
      const exited = once(child, 'exit');
      child.stdin.end('\n');
      await exited;
    }
  },
  15_000,
);

it.each([0, 4, 7, 20])(
  'blob corrupto en byte %s: no restaura y conserva el blob',
  async (offset) => {
    const input = await seed();
    const item = await manager.quarantine(input.id);
    const bytes = await fs.readFile(item.vaultFile);
    bytes[offset] = bytes[offset]! ^ 1;
    await fs.writeFile(item.vaultFile, bytes);
    await expect(
      manager.restore(item.id, { trustHash: false }),
    ).rejects.toThrow();
    expect(await exists(input.path)).toBe(false);
    expect(await exists(item.vaultFile)).toBe(true);
    expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
  },
);
it('restaura con sufijo sin sobrescribir un destino existente', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  await fs.writeFile(input.path, 'Archivo nuevo que no se debe tocar');
  const restored = await manager.restore(item.id, { trustHash: false });
  expect(restored.restoredTo).not.toBe(input.path);
  expect(sha(await fs.readFile(restored.restoredTo!))).toBe(input.hash);
  expect(await fs.readFile(input.path, 'utf8')).toBe(
    'Archivo nuevo que no se debe tocar',
  );
  expect(manager.allowlist.has(input.hash)).toBe(false);
});
it('una colisión al publicar tampoco sobrescribe y revierte la restauración', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  const decrypt = vault.decrypt.bind(vault);
  vi.spyOn(vault, 'decrypt').mockImplementation(
    async (record, output, temp) => {
      const tag = await decrypt(record, output, temp);
      if (output) await fs.writeFile(input.path, 'Llegó durante restauración');
      return tag;
    },
  );
  await expect(
    manager.restore(item.id, { trustHash: false }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(input.path, 'utf8')).toBe(
    'Llegó durante restauración',
  );
  expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
  expect(await exists(item.vaultFile)).toBe(true);
  expect(
    (await fs.readdir(root)).some((name) =>
      name.startsWith('.cybersoc-restore-'),
    ),
  ).toBe(false);
});
it('rechaza restauración por traversal y conserva el blob', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  await expect(
    manager.restore(item.id, {
      trustHash: false,
      targetPath: `${root}/../fuera.txt`,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  expect(await exists(item.vaultFile)).toBe(true);
});
it('delete confirmado solo borra el blob y conserva DELETED y auditoría', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  await fs.writeFile(input.path, 'No tocar este nuevo original');
  await manager.delete(item.id);
  expect(await exists(item.vaultFile)).toBe(false);
  expect(manager.repository.get(item.id)?.status).toBe('DELETED');
  expect(await fs.readFile(input.path, 'utf8')).toBe(
    'No tocar este nuevo original',
  );
  expect(manager.audit.list(item.id).at(-1)?.action).toBe('DELETE');
});
it('dos solicitudes sobre la misma ruta: la segunda se rechaza antes de confirmar', async () => {
  const input = await seed();
  let release!: (value: boolean) => void;
  confirm.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const first = manager.quarantine(input.id);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(manager.quarantine(input.id)).rejects.toMatchObject({
    code: 'BUSY',
  });
  release(true);
  await first;
  expect(confirm).toHaveBeenCalledTimes(1);
});
it('la IA posterior no revoca el hash confiado', async () => {
  const input = await seed();
  const item = await manager.quarantine(input.id);
  await manager.restore(item.id, { trustHash: true });
  new AIAnalysisStore(db).saveAttempt(
    {
      id: 'late-ai',
      kind: 'FILE_RESULT',
      resultId: input.id,
      provider: 'fake',
      promptVersion: 'test',
      contextJson: '{}',
      responseJson: '{}',
      validationStatus: 'VALID',
    },
    'COMPLETED',
    {
      validationStatus: 'VALID',
      opinion: 'LIKELY_MALICIOUS',
      confidence: 1,
      citedEvidenceIds: ['invented'],
    },
  );
  expect(new ScanResultRepository(db).get(input.id)?.verdict).toBe('CLEAN');
  expect(new RiskAssessmentRepository(db).get(input.id)).toMatchObject({
    origin: 'USER_ALLOWLIST',
    policyVersion: '3',
  });
});

describe('reconciliación PENDING al reiniciar', () => {
  async function pending() {
    const input = await seed();
    const item = await manager.quarantine(input.id);
    const record = manager.repository.get(item.id)!;
    record.status = 'PENDING';
    record.quarantinedAt = null;
    manager.repository.update(record);
    return { input, item, record };
  }
  it('blob verificado sin original completa QUARANTINED', async () => {
    const { item } = await pending();
    manager = makeManager();
    await manager.reconcile();
    expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
    expect(confirm).toHaveBeenCalledTimes(1); // Recuperación no inicia nuevas acciones.
  });
  it('original y blob: revierte preservando el original, sin duplicar', async () => {
    const { input, item } = await pending();
    await fs.writeFile(input.path, 'Texto de prueba inofensivo.\n');
    manager = makeManager();
    await manager.reconcile();
    expect(manager.repository.get(item.id)?.status).toBe('FAILED');
    expect(await exists(input.path)).toBe(true);
    expect(await exists(item.vaultFile)).toBe(false);
  });
  it('solo temporal cifrado completo recupera la única copia', async () => {
    const { item, record } = await pending();
    await fs.rename(item.vaultFile, vault.path(item.id, true));
    record.authTagB64 = null;
    manager.repository.update(record);
    manager = makeManager();
    await manager.reconcile();
    expect(manager.repository.get(item.id)?.status).toBe('QUARANTINED');
    expect(await exists(item.vaultFile)).toBe(true);
    expect(await exists(vault.path(item.id, true))).toBe(false);
  });
  it('blob corrupto sin original se conserva para recuperación; no se destruye', async () => {
    const { item } = await pending();
    await fs.writeFile(item.vaultFile, 'truncado');
    manager = makeManager();
    await manager.reconcile();
    expect(manager.repository.get(item.id)?.status).toBe('FAILED');
    expect(await fs.readFile(item.vaultFile, 'utf8')).toBe('truncado');
  });
  it('delete interrumpido completa DELETED aunque el blob ya no exista', async () => {
    const { item, record } = await pending();
    record.errorMessage = 'DELETE_PENDING';
    manager.repository.update(record);
    await fs.unlink(item.vaultFile);
    manager = makeManager();
    await manager.reconcile();
    expect(manager.repository.get(item.id)?.status).toBe('DELETED');
  });
  it('restore publicado antes del cierre completa sin crear otra copia', async () => {
    const { input, item, record } = await pending();
    await fs.writeFile(input.path, 'Texto de prueba inofensivo.\n');
    record.restoredTo = input.path;
    record.errorMessage = 'RESTORE_TRUST_PENDING';
    manager.repository.update(record);
    manager = makeManager();
    await manager.reconcile();
    expect(manager.repository.get(item.id)?.status).toBe('RESTORED');
    expect(await exists(item.vaultFile)).toBe(false);
    expect(manager.allowlist.has(input.hash)).toBe(true);
  });
});

describe('rutas protegidas', () => {
  it.each([
    'C:\\Windows\\system32\\x.txt',
    'c:/WINDOWS/x.txt',
    'C:\\Program Files\\app\\x',
    'c:/program files (x86)/app/x',
    'C:\\ProgramData\\Microsoft\\x',
  ])('rechaza %s por segmento normalizado', (path) => {
    expect(() => new ProtectedPaths([]).assertAllowed(path)).toThrow(
      'protegida',
    );
  });
  it.each([
    'C:\\Windows2\\x.txt',
    'C:/Program Files Otro/x.txt',
    'C:/Users/Ana/niño.txt',
  ])('permite prefijo de nombre diferente: %s', (path) => {
    expect(() => new ProtectedPaths([]).assertAllowed(path)).not.toThrow();
  });
  it('rechaza un archivo real en ruta protegida sin leerlo ni cifrarlo', async () => {
    await fs.mkdir(join(root, 'protected'));
    const input = await seed('protected/texto.txt');
    const encrypt = vi.spyOn(vault, 'encrypt');
    await expect(manager.quarantine(input.id)).rejects.toMatchObject({
      code: 'PROTECTED_PATH',
    });
    expect(encrypt).not.toHaveBeenCalled();
    expect(await exists(input.path)).toBe(true);
    console.log(
      'RUTA_PROTEGIDA rechazada=true original_intacto=true blob_creado=false',
    );
  });
  it('rechaza hardlinks y junctions, sin tocar sus destinos', async () => {
    const input = await seed();
    await fs.link(input.path, join(root, 'alias.txt'));
    await expect(manager.quarantine(input.id)).rejects.toMatchObject({
      code: 'UNSAFE_LINK',
    });
    expect(await exists(input.path)).toBe(true);
    const target = join(root, 'target');
    await fs.mkdir(target);
    await fs.symlink(
      target,
      join(root, 'junction'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const through = await seed('junction/otro.txt');
    await expect(manager.quarantine(through.id)).rejects.toMatchObject({
      code: 'UNSAFE_LINK',
    });
    expect(await exists(through.path)).toBe(true);
  });
  it.each([
    'C:relative.txt',
    'C:/safe/../outside.txt',
    'C:/safe/x:stream',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\Windows\\x',
    'C:/safe/NUL.txt',
    'C:/safe/name.',
  ])('rechaza ruta ambigua: %s', (path) => {
    expect(() => validatePath(path)).toThrow();
  });
});

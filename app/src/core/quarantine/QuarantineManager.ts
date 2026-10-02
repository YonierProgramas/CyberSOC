import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Database } from '../persistence/Database';
import { AuditLog } from '../persistence/AuditLog';
import { AllowlistRepository } from '../persistence/AllowlistRepository';
import { RiskAssessmentRepository } from '../persistence/RiskAssessmentRepository';
import {
  QuarantineRepository,
  publicItem,
  type QuarantineRecord,
  type QuarantineItem,
  type QuarantineStatus,
} from '../persistence/QuarantineRepository';
import {
  ScanResultRepository,
  type ScanResultRecord,
} from '../persistence/ScanResultRepository';
import { QuarantineVault, hashFile } from './QuarantineVault';
import { deleteVerifiedOriginal } from './OriginalFile';
import {
  ProtectedPaths,
  QuarantineError,
  assertNoLinks,
  exists,
  normalizedPath,
  validatePath,
} from './paths';

export interface Confirmation {
  action: 'QUARANTINE' | 'RESTORE' | 'RESTORE_DETECTED' | 'DELETE';
  path: string;
  verdict: string;
  trustHash?: boolean;
}
export interface QuarantineOptions {
  database: Database;
  vault: QuarantineVault;
  protectedPaths: ProtectedPaths;
  /** Requerido: solo el adaptador de main puede pedir confirmación humana. Sin callback no se actúa. */
  confirm: (request: Confirmation) => Promise<boolean>;
}

export class QuarantineManager {
  readonly repository: QuarantineRepository;
  readonly audit: AuditLog;
  readonly allowlist: AllowlistRepository;
  // Map: invariante, una única promesa por ruta normalizada mientras una acción está activa.
  // has/set/delete cuestan O(1) promedio (normalizar O(L)); memoria O(k), k operaciones.
  // Tras canonizar la ruta, has/set son síncronos y preceden a confirmar o modificar.
  // Se elimina en finally, también ante fallos.
  private readonly operations = new Map<string, Promise<unknown>>();
  private closing = false;
  private recovery: Promise<void> | undefined;
  constructor(private readonly options: QuarantineOptions) {
    this.repository = new QuarantineRepository(options.database);
    this.audit = new AuditLog(options.database);
    this.allowlist = new AllowlistRepository(options.database);
  }
  list(status?: QuarantineStatus): QuarantineItem[] {
    return this.repository.list(status).map(publicItem);
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.recovery;
    await Promise.allSettled(this.operations.values());
  }
  private async run<T>(
    path: string,
    id: string,
    action: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.closing)
      throw new QuarantineError('CLOSING', 'La app se está cerrando.');
    // Canonizar también unifica aliases 8.3 de Windows para el bloqueo por ruta.
    const key = normalizedPath(await realpath(path).catch(() => path));
    if (this.closing)
      throw new QuarantineError('CLOSING', 'La app se está cerrando.');
    if (this.operations.has(key)) {
      this.audit.append(`${action}_REJECTED`, id, { code: 'BUSY' });
      throw new QuarantineError(
        'BUSY',
        'Ya hay una operación sobre este archivo.',
      );
    }
    const promise = Promise.resolve().then(async () => {
      await this.recovery;
      return work();
    });
    this.operations.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this.audit.append(`${action}_FAILED`, id, { code: errorCode(error) });
      throw error;
    } finally {
      this.operations.delete(key);
    }
  }
  private async confirm(request: Confirmation): Promise<void> {
    if (!(await this.options.confirm(request)))
      throw new QuarantineError(
        'CANCELLED',
        'Acción cancelada por el usuario.',
      );
  }
  private async allowed(path: string, existing: boolean): Promise<string> {
    const valid = validatePath(path);
    this.options.protectedPaths.assertAllowed(valid);
    await assertNoLinks(existing ? valid : dirname(valid));
    const canonical = existing
      ? await realpath(valid)
      : join(await realpath(dirname(valid)), basename(valid));
    this.options.protectedPaths.assertAllowed(canonical);
    return canonical;
  }
  private item(id: string): QuarantineRecord {
    const item = this.repository.get(id);
    if (!item) {
      this.audit.append('QUARANTINE_ITEM_REJECTED', id, { code: 'NOT_FOUND' });
      throw new QuarantineError('NOT_FOUND', 'No existe el ítem.');
    }
    // El campo de la BD no puede desviar lecturas/borrados fuera de la bóveda.
    if (item.vaultFile !== this.options.vault.path(id)) {
      this.audit.append('QUARANTINE_ITEM_REJECTED', id, {
        code: 'INVALID_ITEM',
      });
      throw new QuarantineError('INVALID_ITEM', 'Ruta de bóveda inválida.');
    }
    return item;
  }
  private commit(
    item: QuarantineRecord,
    action: string,
    actor: 'USER' | 'SYSTEM' = 'USER',
  ): void {
    this.options.database.transaction(() => {
      this.repository.update(item);
      this.audit.append(
        action,
        item.id,
        { status: item.status, code: item.errorMessage },
        actor,
      );
    });
  }
  async quarantine(resultId: string): Promise<QuarantineItem> {
    const result = new ScanResultRepository(this.options.database).get(
      resultId,
    );
    if (!result) {
      this.audit.append('QUARANTINE_REJECTED', resultId, { code: 'NOT_FOUND' });
      throw new QuarantineError('NOT_FOUND', 'No existe el resultado.');
    }
    return this.run(result.path, resultId, 'QUARANTINE', () =>
      this.isolate(result),
    );
  }
  private async isolate(result: ScanResultRecord): Promise<QuarantineItem> {
    // 1. Confirmación explícita; nunca se invoca desde el worker de IA ni al escanear.
    await this.confirm({
      action: 'QUARANTINE',
      path: result.path,
      verdict: result.verdict,
    });
    if (
      result.status !== 'SCANNED' ||
      !result.sha256 ||
      !['DETECTED', 'SUSPICIOUS'].includes(result.verdict)
    )
      throw new QuarantineError(
        'NOT_ELIGIBLE',
        'Solo se aíslan resultados detectados o sospechosos ya escaneados.',
      );
    // 2. Prefijos protegidos, enlaces, dispositivos y rutas ambiguas.
    const path = await this.allowed(result.path, true);
    const source = await open(path, 'r');
    let item: QuarantineRecord | undefined;
    let removed = false;
    try {
      const before = await source.stat();
      if (!before.isFile() || before.nlink !== 1)
        throw new QuarantineError(
          'UNSAFE_LINK',
          'Se requiere un archivo regular sin enlaces duros.',
        );
      // 3. El hash vuelve a calcularse; la extensión o el nombre nunca sustituyen esta comprobación.
      const sha256 = await hashFile(source);
      if (sha256 !== result.sha256 || before.size !== result.sizeBytes)
        throw new QuarantineError(
          'FILE_CHANGED',
          'El archivo cambió. Vuelve a escanearlo.',
        );
      await this.options.vault.initialize();
      const id = randomUUID();
      item = {
        id,
        resultId: result.id,
        originalPath: path,
        sha256,
        sizeBytes: before.size,
        vaultFile: this.options.vault.path(id),
        ...this.options.vault.key(),
        authTagB64: null,
        reason: `Resultado ${result.verdict} confirmado por el usuario`,
        verdictSnapshot: result.verdict,
        status: 'PENDING',
        quarantinedAt: null,
        restoredAt: null,
        restoredTo: null,
        deletedAt: null,
        errorMessage: null,
      };
      // 4. Journal durable antes de crear el blob; clave e IV sobreviven a un cierre.
      this.options.database.transaction(() => {
        this.repository.insert(item!);
        this.audit.append('QUARANTINE_PENDING', id, { resultId: result.id });
      });
      // 5. Cifrado temporal, flush, descifrado verificado y publicación sin reemplazo.
      item.authTagB64 = await this.options.vault.encrypt(source, item);
      this.repository.update(item);
      // Revalidación adicional: otro proceso pudo cambiar/reemplazar la ruta durante el cifrado.
      await this.allowed(path, true);
      const current = await lstat(path);
      const after = await source.stat();
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.nlink !== 1 ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        (await hashFile(source)) !== sha256
      )
        throw new QuarantineError(
          'FILE_CHANGED',
          'El archivo cambió durante la cuarentena. Vuelve a escanearlo.',
        );
      // 6. Solo ahora se borra la ruta original confirmada. Un fallo conserva el original.
      await deleteVerifiedOriginal(path, sha256);
      removed = true;
      // 7. Estado y auditoría en la misma transacción. Si falla, PENDING retiene la copia válida.
      item.status = 'QUARANTINED';
      item.quarantinedAt = new Date().toISOString();
      this.commit(item, 'QUARANTINE');
      return publicItem(item);
    } catch (error) {
      if (item && !removed) {
        // Un cierre del helper sin acuse puede suceder DESPUÉS del borrado.
        // No se elimina la única copia verificada en ese caso; el journal lo resuelve al iniciar.
        if (errorCode(error) === 'DELETE_UNCERTAIN' || !(await exists(path)))
          throw error;
        // Si no podemos limpiar, se conserva PENDING para reconciliar, nunca se oculta el fallo.
        await this.options.vault.remove(item.id);
        await this.options.vault.remove(item.id, true);
        item.status = 'FAILED';
        item.errorMessage = errorCode(error);
        this.commit(item, 'QUARANTINE_FAILED');
      }
      throw error;
    } finally {
      await source.close();
    }
  }
  async restore(
    itemId: string,
    opts: { trustHash: boolean; targetPath?: string },
  ): Promise<QuarantineItem> {
    const initial = this.item(itemId);
    return this.run(initial.originalPath, itemId, 'RESTORE', async () => {
      const item = this.item(itemId);
      if (item.status !== 'QUARANTINED')
        throw new QuarantineError(
          'INVALID_STATE',
          'El ítem no está en cuarentena.',
        );
      if (typeof opts.trustHash !== 'boolean')
        throw new QuarantineError(
          'INVALID_OPTIONS',
          'Debes indicar si confías en el hash.',
        );
      let target = await this.allowed(
        opts.targetPath ?? item.originalPath,
        false,
      );
      if (await exists(target)) {
        const extension = extname(target);
        const stem = basename(target, extension);
        let suffix = 1;
        do {
          target = join(
            dirname(target),
            `${stem}.restored-${suffix++}${extension}`,
          );
        } while (await exists(target));
      }
      const request = {
        action: 'RESTORE' as const,
        path: target,
        verdict: item.verdictSnapshot,
        trustHash: opts.trustHash,
      };
      await this.confirm(request);
      if (item.verdictSnapshot === 'DETECTED')
        await this.confirm({ ...request, action: 'RESTORE_DETECTED' });
      await this.allowed(target, false);
      await this.options.vault.verify(item);
      item.status = 'PENDING';
      item.restoredTo = target;
      item.errorMessage = opts.trustHash
        ? 'RESTORE_TRUST_PENDING'
        : 'RESTORE_PENDING';
      this.commit(item, 'RESTORE_PENDING');
      const temp = this.restoreTemp(item);
      let output: FileHandle | undefined;
      let ownedTemp = false;
      let published = false;
      try {
        output = await open(temp, 'wx', 0o600);
        ownedTemp = true;
        await this.options.vault.decrypt(item, output);
        await output.close();
        output = undefined;
        await this.allowed(target, false);
        // link no reemplaza: incluso si aparece un destino DESPUÉS de la comprobación, falla.
        await link(temp, target);
        published = true;
        await unlink(temp);
        ownedTemp = false;
        await this.finishRestore(item, 'USER');
        return publicItem(item);
      } catch (error) {
        await output?.close();
        if (ownedTemp) await unlink(temp);
        if (!published) {
          item.status = 'QUARANTINED';
          item.restoredTo = null;
          item.errorMessage = errorCode(error);
          this.commit(item, 'RESTORE_FAILED');
        }
        // Tras publicar, PENDING permite completar sin generar una segunda restauración.
        throw error;
      }
    });
  }
  private restoreTemp(item: QuarantineRecord): string {
    return join(dirname(item.restoredTo!), `.cybersoc-restore-${item.id}.tmp`);
  }
  private async finishRestore(
    item: QuarantineRecord,
    actor: 'USER' | 'SYSTEM',
  ): Promise<void> {
    const trust = item.errorMessage === 'RESTORE_TRUST_PENDING';
    const target = await this.allowed(item.restoredTo!, true);
    const restored = await open(target, 'r');
    try {
      if ((await hashFile(restored)) !== item.sha256)
        throw new QuarantineError(
          'FILE_CHANGED',
          'El destino cambió antes de completar la restauración.',
        );
    } finally {
      await restored.close();
    }
    await this.options.vault.remove(item.id);
    item.status = 'RESTORED';
    item.restoredAt = new Date().toISOString();
    item.errorMessage = null;
    this.options.database.transaction(() => {
      if (trust) {
        this.allowlist.add(
          item.sha256,
          'Restaurado y confiado explícitamente por el usuario',
        );
        new RiskAssessmentRepository(this.options.database).applyAllowlist(
          item.sha256,
        );
        this.audit.append(
          'ALLOWLIST_ADD',
          item.id,
          { sha256: item.sha256 },
          actor,
        );
      }
      this.commit(item, 'RESTORE', actor);
    });
  }
  async delete(itemId: string): Promise<void> {
    const initial = this.item(itemId);
    return this.run(initial.originalPath, itemId, 'DELETE', async () => {
      const item = this.item(itemId);
      if (item.status !== 'QUARANTINED')
        throw new QuarantineError(
          'INVALID_STATE',
          'El ítem no está en cuarentena.',
        );
      await this.confirm({
        action: 'DELETE',
        path: item.originalPath,
        verdict: item.verdictSnapshot,
      });
      item.status = 'PENDING';
      item.errorMessage = 'DELETE_PENDING';
      this.commit(item, 'DELETE_PENDING');
      await this.finishDelete(item, 'USER');
    });
  }
  private async finishDelete(
    item: QuarantineRecord,
    actor: 'USER' | 'SYSTEM',
  ): Promise<void> {
    await this.options.vault.remove(item.id);
    await this.options.vault.remove(item.id, true);
    item.status = 'DELETED';
    item.deletedAt = new Date().toISOString();
    item.errorMessage = null;
    this.commit(item, 'DELETE', actor);
  }
  /** Recuperación conservadora: no vuelve a borrar originales al iniciar. Completa o revierte el journal. */
  reconcile(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.operations.size > 0)
      return Promise.reject(
        new QuarantineError('BUSY', 'Hay operaciones activas.'),
      );
    this.recovery = this.recover();
    return this.recovery;
  }
  private async recover(): Promise<void> {
    // Sin pendientes no se crea una bóveda ni se toca ningún archivo del usuario.
    const pending = this.repository.list('PENDING');
    if (!pending.length) return;
    await this.options.vault.initialize();
    for (const row of pending) {
      try {
        const item = this.item(row.id);
        if (item.errorMessage === 'DELETE_PENDING') {
          await this.finishDelete(item, 'SYSTEM');
          continue;
        }
        if (item.restoredTo !== null) {
          await this.recoverRestore(item);
          continue;
        }
        const path = validatePath(item.originalPath);
        this.options.protectedPaths.assertAllowed(path);
        let originalMatches = false;
        if (await exists(path)) {
          await this.allowed(path, true);
          const original = await open(path, 'r');
          try {
            originalMatches = (await hashFile(original)) === item.sha256;
          } finally {
            await original.close();
          }
        }
        if (originalMatches) {
          await this.options.vault.remove(item.id);
          await this.options.vault.remove(item.id, true);
          item.status = 'FAILED';
          item.errorMessage = 'RECOVERED_ORIGINAL_KEPT';
        } else {
          // Si solo quedó el temporal cifrado completo, recuperarlo sin perder la última copia.
          if (
            !(await exists(this.options.vault.path(item.id))) &&
            (await exists(this.options.vault.path(item.id, true)))
          ) {
            await this.options.vault.verify(item, true);
            await link(
              this.options.vault.path(item.id, true),
              this.options.vault.path(item.id),
            );
          }
          item.authTagB64 = await this.options.vault.verify(item);
          await this.options.vault.remove(item.id, true);
          item.status = 'QUARANTINED';
          item.quarantinedAt = new Date().toISOString();
          item.errorMessage = null;
        }
        this.commit(item, 'RECONCILE', 'SYSTEM');
      } catch (error) {
        // Un blob ilegible sin original no se destruye: conservar para recuperación manual.
        row.status = 'FAILED';
        row.errorMessage = errorCode(error);
        this.commit(row, 'RECONCILE_FAILED', 'SYSTEM');
      }
    }
  }
  private async recoverRestore(item: QuarantineRecord): Promise<void> {
    const target = await this.allowed(item.restoredTo!, false);
    const temp = this.restoreTemp(item);
    if (await exists(target)) {
      await this.allowed(target, true);
      const file = await open(target, 'r');
      try {
        if ((await hashFile(file)) !== item.sha256)
          throw new QuarantineError(
            'FILE_CHANGED',
            'El destino de restauración cambió.',
          );
      } finally {
        await file.close();
      }
      if (await exists(temp)) {
        await assertNoLinks(temp);
        await unlink(temp);
      }
      await this.finishRestore(item, 'SYSTEM');
    } else {
      await this.options.vault.verify(item);
      if (await exists(temp)) {
        await assertNoLinks(temp);
        await unlink(temp);
      }
      item.status = 'QUARANTINED';
      item.restoredTo = null;
      item.errorMessage = 'RESTORE_ROLLED_BACK';
      this.commit(item, 'RECONCILE', 'SYSTEM');
    }
  }
}
function errorCode(error: unknown): string {
  return error instanceof QuarantineError
    ? error.code
    : ((error as NodeJS.ErrnoException)?.code ?? 'IO_ERROR');
}

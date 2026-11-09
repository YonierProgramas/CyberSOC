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
  /** Required: only the main adapter can request human confirmation. No callback, no action. */
  confirm: (request: Confirmation) => Promise<boolean>;
}

export class QuarantineManager {
  readonly repository: QuarantineRepository;
  readonly audit: AuditLog;
  readonly allowlist: AllowlistRepository;
  // Map: invariant, a single promise per normalized path while an action is active.
  // has/set/delete cuestan O(1) promedio (normalizar O(L)); memoria O(k), k operaciones.
  // After canonicalizing the path, has/set are synchronous and precede confirming or modifying.
  // Removed in finally, also on failures.
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
    // Canonicalizing also unifies Windows 8.3 aliases for the per-path lock.
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
    // The DB field cannot divert reads/deletes outside the vault.
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
    // 1. Explicit confirmation; never invoked from the AI worker or while scanning.
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
    // 2. Protected prefixes, links, devices and ambiguous paths.
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
      // 3. The hash is recomputed; the extension or name never replace this check.
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
      // 4. Durable journal before creating the blob; key and IV survive a shutdown.
      this.options.database.transaction(() => {
        this.repository.insert(item!);
        this.audit.append('QUARANTINE_PENDING', id, { resultId: result.id });
      });
      // 5. Temporary encryption, flush, verified decryption and publishing without replacement.
      item.authTagB64 = await this.options.vault.encrypt(source, item);
      this.repository.update(item);
      // Additional revalidation: another process may have changed/replaced the path during encryption.
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
      // 6. Only now is the confirmed original path deleted. A failure keeps the original.
      await deleteVerifiedOriginal(path, sha256);
      removed = true;
      // 7. Status and audit in the same transaction. If it fails, PENDING retains the valid copy.
      item.status = 'QUARANTINED';
      item.quarantinedAt = new Date().toISOString();
      this.commit(item, 'QUARANTINE');
      return publicItem(item);
    } catch (error) {
      if (item && !removed) {
        // A helper shutdown without acknowledgment may happen AFTER the deletion.
        // The only verified copy is not deleted in that case; the journal resolves it at startup.
        if (errorCode(error) === 'DELETE_UNCERTAIN' || !(await exists(path)))
          throw error;
        // If cleanup is impossible, PENDING is kept for reconciliation; the failure is never hidden.
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
        // link does not replace: even if a target appears AFTER the check, it fails.
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
        // After publishing, PENDING allows completing without generating a second restoration.
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
  /** Conservative recovery: it does not delete originals again at startup. It completes or reverts the journal. */
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
    // Without pending items no vault is created and no user file is touched.
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
          // If only the complete encrypted temporary remained, recover it without losing the last copy.
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
        // An unreadable blob without an original is not destroyed: kept for manual recovery.
        row.status = 'FAILED';
        row.errorMessage = errorCode(error);
        this.commit(row, 'RECONCILE_FAILED', 'SYSTEM');
      }
    }
  }
  private async recoverRestore(item: QuarantineRecord): Promise<void> {
    const target = await this.allowed(item.restoredTo!, false);
    const temp = this.restoreTemp(item);
    let targetMatches = false;
    if (await exists(target)) {
      await this.allowed(target, true);
      const file = await open(target, 'r');
      try {
        targetMatches =
          (await file.stat()).isFile() &&
          (await hashFile(file)) === item.sha256;
      } finally {
        await file.close();
      }
    }
    // The temporary belongs to this restoration; do not keep decrypted content
    // after a shutdown, even if another application took the target or the blob was damaged.
    if (await exists(temp)) {
      await assertNoLinks(temp);
      await unlink(temp);
    }
    if (targetMatches) {
      await this.finishRestore(item, 'SYSTEM');
    } else {
      // Never touch the foreign file. The verified encrypted copy becomes available again
      // to restore with a suffix or delete after a new confirmation.
      await this.options.vault.verify(item);
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

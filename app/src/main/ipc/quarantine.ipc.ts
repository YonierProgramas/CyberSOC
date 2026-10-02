import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { Database } from '../../core/persistence/Database';
import { ScanResultRepository } from '../../core/persistence/ScanResultRepository';
import {
  QuarantineRepository,
  type QuarantineItem,
} from '../../core/persistence/QuarantineRepository';
import type {
  Confirmation,
  QuarantineManager,
} from '../../core/quarantine/QuarantineManager';
import { QuarantineError } from '../../core/quarantine/paths';
import {
  createQuarantineSchemas,
  QUARANTINE_LIST,
  QUARANTINE_QUARANTINE,
  QUARANTINE_RESTORE,
  QUARANTINE_DELETE,
  QUARANTINE_CHANGED,
  type QuarantineItemDTO,
  type QuarantineChanged,
} from '../../shared/ipc';
import { requireTrustedSender, trustedWindow } from './scan-validation';

/** La UI confirma antes de invocar. Solo la petición IPC validada habilita su acción.
 * AsyncLocalStorage mantiene aisladas las confirmaciones de operaciones concurrentes.
 * Fuera de ese contexto el gestor sigue rechazando cualquier disparo automático.
 */
export class QuarantineUIConfirmation {
  private readonly context = new AsyncLocalStorage<{
    action: 'QUARANTINE' | 'RESTORE' | 'DELETE';
    active: boolean;
  }>();
  readonly confirm = async (request: Confirmation): Promise<boolean> => {
    const context = this.context.getStore();
    return (
      context?.active === true &&
      (request.action === context.action ||
        (context.action === 'RESTORE' && request.action === 'RESTORE_DETECTED'))
    );
  };
  async run<T>(
    action: 'QUARANTINE' | 'RESTORE' | 'DELETE',
    operation: () => Promise<T>,
  ): Promise<T> {
    const context = { action, active: true };
    return this.context.run(context, async () => {
      try {
        return await operation();
      } finally {
        context.active = false;
      }
    });
  }
}

const schemas = createQuarantineSchemas(z);
function dto(item: QuarantineItem): QuarantineItemDTO {
  return schemas.item.parse({
    id: item.id,
    resultId: item.resultId,
    originalPath: item.originalPath,
    sha256: item.sha256,
    sizeBytes: item.sizeBytes,
    reason: item.reason,
    verdictSnapshot: item.verdictSnapshot,
    status: item.status,
    quarantinedAt: item.quarantinedAt,
    restoredAt: item.restoredAt,
    restoredTo: item.restoredTo,
    deletedAt: item.deletedAt,
    errorMessage: item.errorMessage,
  });
}

const safeCodes = [
  'CANCELLED',
  'BUSY',
  'CLOSING',
  'INVALID_PATH',
  'PROTECTED_PATH',
  'UNSAFE_LINK',
  'INVALID_ITEM',
  'NOT_FOUND',
  'NOT_ELIGIBLE',
  'FILE_CHANGED',
  'CORRUPT_BLOB',
  'HASH_MISMATCH',
  'INVALID_STATE',
  'INVALID_OPTIONS',
  'DELETE_FAILED',
  'DELETE_UNCERTAIN',
];

export function registerQuarantineIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  manager: Pick<
    QuarantineManager,
    'list' | 'quarantine' | 'restore' | 'delete'
  >,
  database: Database,
  confirmation: QuarantineUIConfirmation,
): () => void {
  const results = new ScanResultRepository(database);
  const items = new QuarantineRepository(database);
  let active = true;
  const channels = [
    QUARANTINE_LIST,
    QUARANTINE_QUARANTINE,
    QUARANTINE_RESTORE,
    QUARANTINE_DELETE,
  ];
  function validate(event: IpcMainInvokeEvent): void {
    if (!active) throw new Error('IPC cerrado.');
    requireTrustedSender(getWindow, trustedRendererUrl, event);
  }
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      let change: QuarantineChanged | undefined;
      try {
        validate(event);
        if (channel === QUARANTINE_LIST) {
          const [query] = schemas.listArguments.parse(args);
          return manager.list(query?.status).map(dto);
        }
        if (channel === QUARANTINE_QUARANTINE) {
          const [resultId] = schemas.idArguments.parse(args);
          if (!results.get(resultId))
            throw new QuarantineError('NOT_FOUND', '');
          change = { resultId, itemId: null };
          const item = await confirmation.run('QUARANTINE', () =>
            manager.quarantine(resultId),
          );
          change.itemId = item.id;
          validate(event);
          return dto(item);
        }
        const [itemId, options] =
          channel === QUARANTINE_RESTORE
            ? schemas.restoreArguments.parse(args)
            : ([...schemas.idArguments.parse(args), undefined] as const);
        const item = items.get(itemId);
        if (!item) throw new QuarantineError('NOT_FOUND', '');
        change = { itemId, resultId: item.resultId };
        if (options) {
          const restored = await confirmation.run('RESTORE', () =>
            manager.restore(itemId, options),
          );
          validate(event);
          return dto(restored);
        }
        await confirmation.run('DELETE', () => manager.delete(itemId));
        validate(event);
        return undefined;
      } catch (error) {
        // No devolver errores internos, trazas, argumentos ni registros con claves.
        const code =
          error instanceof QuarantineError && safeCodes.includes(error.code)
            ? error.code
            : 'QUARANTINE_FAILED';
        throw new Error(
          `No se pudo completar la operación de cuarentena (${code}).`,
        );
      } finally {
        // También refrescar FAILED/PENDING tras un error. El evento no afirma éxito.
        if (active && change) {
          const window = trustedWindow(getWindow, trustedRendererUrl);
          // Una ventana que se cerró/navegó no debe recibir el resultado pendiente.
          if (
            window?.webContents === event.sender &&
            window.webContents.mainFrame === event.senderFrame
          ) {
            try {
              window.webContents.send(QUARANTINE_CHANGED, change);
            } catch {
              /* La ventana puede cerrarse durante el envío; la BD ya conserva el estado. */
            }
          }
        }
      }
    });
  }
  return () => {
    if (!active) return;
    active = false;
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
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

/** The IPC context enables asking for permission; it never equals human consent.
 * AsyncLocalStorage keeps confirmations of concurrent operations isolated.
 * Outside that context the manager keeps rejecting any automatic trigger.
 * Each step (including RESTORE_DETECTED) requires its own native dialog in main.
 */
export class QuarantineUIConfirmation {
  private readonly context = new AsyncLocalStorage<{
    action: 'QUARANTINE' | 'RESTORE' | 'DELETE';
    active: boolean;
    validate: () => void;
  }>();
  readonly confirm = async (request: Confirmation): Promise<boolean> => {
    const context = this.context.getStore();
    if (
      context?.active !== true ||
      !(
        request.action === context.action ||
        (context.action === 'RESTORE' && request.action === 'RESTORE_DETECTED')
      )
    )
      return false;
    context.validate();
    const labels = {
      QUARANTINE: 'Poner en cuarentena',
      RESTORE: 'Restaurar',
      RESTORE_DETECTED: 'Confirmar restauración de archivo detectado',
      DELETE: 'Eliminar definitivamente el archivo de la bóveda',
    };
    const answer = await dialog.showMessageBox({
      type: 'warning',
      title: labels[request.action],
      message: labels[request.action],
      detail:
        `Ruta: ${JSON.stringify(request.path)}\nVeredicto: ${request.verdict}.` +
        (request.trustHash ? '\nTambién confiarás en este SHA-256.' : ''),
      buttons: ['Cancelar', labels[request.action]],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    // The renderer may close or navigate while waiting for the human decision.
    if (!context.active) return false;
    context.validate();
    return answer.response === 1;
  };
  async run<T>(
    action: 'QUARANTINE' | 'RESTORE' | 'DELETE',
    operation: () => Promise<T>,
    validate: () => void = () => {},
  ): Promise<T> {
    const context = { action, active: true, validate };
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
          const item = await confirmation.run(
            'QUARANTINE',
            () => manager.quarantine(resultId),
            () => validate(event),
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
          const restored = await confirmation.run(
            'RESTORE',
            () => manager.restore(itemId, options),
            () => validate(event),
          );
          validate(event);
          return dto(restored);
        }
        await confirmation.run(
          'DELETE',
          () => manager.delete(itemId),
          () => validate(event),
        );
        validate(event);
        return undefined;
      } catch (error) {
        // Do not return internal errors, traces, arguments or records with keys.
        const code =
          error instanceof QuarantineError && safeCodes.includes(error.code)
            ? error.code
            : 'QUARANTINE_FAILED';
        throw new Error(
          `No se pudo completar la operación de cuarentena (${code}).`,
        );
      } finally {
        // Also refresh FAILED/PENDING after an error. The event does not claim success.
        if (active && change) {
          const window = trustedWindow(getWindow, trustedRendererUrl);
          // A window that closed/navigated must not receive the pending result.
          if (
            window?.webContents === event.sender &&
            window.webContents.mainFrame === event.senderFrame
          ) {
            try {
              window.webContents.send(QUARANTINE_CHANGED, change);
            } catch {
              /* The window may close during the send; the DB already holds the state. */
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

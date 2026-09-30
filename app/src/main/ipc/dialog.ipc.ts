import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import { DIALOG_SELECT_FILE, DIALOG_SELECT_FOLDER } from '../../shared/ipc';
import {
  noArguments,
  existingScanTarget,
  requireTrustedSender,
} from './scan-validation';

export function registerDialogIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
): () => void {
  const channels = [DIALOG_SELECT_FOLDER, DIALOG_SELECT_FILE] as const;
  for (const [index, kind] of (['FOLDER', 'FILE'] as const).entries()) {
    ipcMain.handle(
      channels[index]!,
      async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<string | null> => {
        const window = requireTrustedSender(
          getWindow,
          trustedRendererUrl,
          event,
        );
        noArguments.parse(args);
        const result = await dialog.showOpenDialog(window, {
          title:
            kind === 'FOLDER'
              ? 'Seleccionar carpeta para escanear'
              : 'Seleccionar archivo para escanear',
          properties: [kind === 'FOLDER' ? 'openDirectory' : 'openFile'],
        });
        requireTrustedSender(getWindow, trustedRendererUrl, event);
        if (result.canceled || result.filePaths.length === 0) return null;
        const target = await existingScanTarget({
          kind,
          path: result.filePaths[0],
        });
        requireTrustedSender(getWindow, trustedRendererUrl, event);
        return target.path;
      },
    );
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

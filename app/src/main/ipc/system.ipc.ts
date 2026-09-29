import { app, ipcMain, type BrowserWindow } from 'electron';
import { SYSTEM_GET_STATUS, type SystemStatus } from '../../shared/ipc';

export function registerSystemIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
): void {
  ipcMain.handle(SYSTEM_GET_STATUS, (event): SystemStatus => {
    const window = getWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== trustedRendererUrl
    ) {
      throw new Error('Origen IPC no autorizado.');
    }

    return { app: 'CyberSOC Defender', version: app.getVersion() };
  });
}

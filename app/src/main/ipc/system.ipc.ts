import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  SYSTEM_GET_STATUS,
  SYSTEM_RECONNECT_ENGINE,
  type SystemStatus,
  type EngineState,
} from '../../shared/ipc';
import {
  systemArgumentsSchema,
  systemStatusSchema,
} from '../../shared/system-schemas';

export interface EngineController {
  getState(): EngineState;
  reconnect(): Promise<EngineState>;
}

export function registerSystemIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  engine: EngineController,
): void {
  function validate(event: IpcMainInvokeEvent, args: unknown[]): void {
    const window = getWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== trustedRendererUrl
    ) {
      throw new Error('Origen IPC no autorizado.');
    }
    systemArgumentsSchema.parse(args);
  }

  function status(): SystemStatus {
    return systemStatusSchema.parse({
      app: 'CyberSOC Defender',
      version: app.getVersion(),
      engine: engine.getState(),
    });
  }

  ipcMain.handle(
    SYSTEM_GET_STATUS,
    (event, ...args: unknown[]): SystemStatus => {
      validate(event, args);
      return status();
    },
  );
  ipcMain.handle(
    SYSTEM_RECONNECT_ENGINE,
    async (event, ...args: unknown[]): Promise<SystemStatus> => {
      validate(event, args);
      await engine.reconnect();
      return status();
    },
  );
}

import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSystemIpc } from './ipc/system.ipc';
import { createMainWindow } from './window';
import { createEngine } from './composition-root';

let mainWindow: BrowserWindow | null = null;
const rendererPath = join(__dirname, '../renderer/index.html');
const engine = createEngine(app.getAppPath());
let readyToQuit = false;
let quitting = false;

app.on('before-quit', (event) => {
  if (readyToQuit) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void engine
    .close()
    .catch((error: unknown) =>
      console.error('Error al cerrar el motor:', error),
    )
    .finally(() => {
      readyToQuit = true;
      app.quit();
    });
});

async function openMainWindow(): Promise<void> {
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadFile(rendererPath);
}

app
  .whenReady()
  .then(async () => {
    registerSystemIpc(
      () => mainWindow,
      pathToFileURL(rendererPath).href,
      engine,
    );
    void engine
      .reconnect()
      .catch((error: unknown) =>
        console.error('Error al iniciar el motor:', error),
      );
    await openMainWindow();

    app.on('activate', () => {
      if (!mainWindow) void openMainWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('No se pudo iniciar CyberSOC Defender:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

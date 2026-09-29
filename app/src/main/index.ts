import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSystemIpc } from './ipc/system.ipc';
import { createMainWindow } from './window';

let mainWindow: BrowserWindow | null = null;
const rendererPath = join(__dirname, '../renderer/index.html');

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
    registerSystemIpc(() => mainWindow, pathToFileURL(rendererPath).href);
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

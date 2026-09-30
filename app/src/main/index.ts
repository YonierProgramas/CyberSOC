import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSystemIpc } from './ipc/system.ipc';
import { registerDialogIpc } from './ipc/dialog.ipc';
import { registerScanIpc } from './ipc/scan.ipc';
import { registerSettingsIpc } from './ipc/settings.ipc';
import { createMainWindow } from './window';
import {
  createDatabase,
  createEngine,
  createScanOrchestrator,
  createAISettings,
  createAIWorkflow,
} from './composition-root';
import type { Database } from '../core/persistence/Database';
import type { AIAnalysisWorker } from '../core/ai/AIAnalysisWorker';

let mainWindow: BrowserWindow | null = null;
const rendererPath = join(__dirname, '../renderer/index.html');
const engine = createEngine(app.getAppPath());
let database: Database | null = null;
let stopScanIpc: (() => Promise<void>) | null = null;
let stopDialogIpc: (() => void) | null = null;
let stopSettingsIpc: (() => void) | null = null;
let aiWorker: AIAnalysisWorker | null = null;
let readyToQuit = false;
let quitting = false;

app.on('will-quit', () => {
  database?.close();
  database = null;
});

app.on('before-quit', (event) => {
  if (readyToQuit) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  stopSettingsIpc?.();
  stopSettingsIpc = null;
  stopDialogIpc?.();
  stopDialogIpc = null;
  void Promise.allSettled([
    stopScanIpc?.() ?? Promise.resolve(),
    aiWorker?.stop() ?? Promise.resolve(),
  ])
    .then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        console.error('No se pudo finalizar algún trabajo pendiente.');
    })
    .then(() => engine.close())
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
    database = createDatabase(app.getPath('userData'));
    aiWorker = createAIWorkflow(database);
    aiWorker.on('workerError', () =>
      console.error('El worker de IA se ha pausado.'),
    );
    aiWorker.start();
    const trustedRendererUrl = pathToFileURL(rendererPath).href;
    stopSettingsIpc = registerSettingsIpc(
      () => mainWindow,
      trustedRendererUrl,
      createAISettings(database, { onReady: () => aiWorker?.resume() }),
    );
    const scan = createScanOrchestrator(database, engine, aiWorker);
    stopDialogIpc = registerDialogIpc(() => mainWindow, trustedRendererUrl);
    stopScanIpc = registerScanIpc(
      () => mainWindow,
      trustedRendererUrl,
      scan,
      database,
      aiWorker,
    );
    registerSystemIpc(() => mainWindow, trustedRendererUrl, engine);
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

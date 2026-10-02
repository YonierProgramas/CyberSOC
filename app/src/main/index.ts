import {
  registerQuarantineIpc,
  QuarantineUIConfirmation,
} from './ipc/quarantine.ipc';
import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSystemIpc } from './ipc/system.ipc';
import { registerDialogIpc } from './ipc/dialog.ipc';
import { registerScanIpc } from './ipc/scan.ipc';
import { registerSettingsIpc } from './ipc/settings.ipc';
import { registerAssistantIpc } from './ipc/assistant.ipc';
import { registerReportsIpc } from './ipc/reports.ipc';
import { ReportBuilder } from '../core/reports/ReportBuilder';
import { createMainWindow } from './window';
import {
  createDatabase,
  createEngine,
  createScanOrchestrator,
  createAISettings,
  createAIWorkflow,
  createAIProvider,
  createQuarantineManager,
} from './composition-root';
import type { Database } from '../core/persistence/Database';
import type { AIAnalysisWorker } from '../core/ai/AIAnalysisWorker';
import { AssistantOrchestrator } from '../core/ai/AssistantOrchestrator';
import { AppConfigStore } from '../core/config/AppConfig';
import type { QuarantineManager } from '../core/quarantine/QuarantineManager';

let mainWindow: BrowserWindow | null = null;
const rendererPath = join(__dirname, '../renderer/index.html');
const engine = createEngine(app.getAppPath());
let database: Database | null = null;
let stopScanIpc: (() => Promise<void>) | null = null;
let stopDialogIpc: (() => void) | null = null;
let stopQuarantineIpc: (() => void) | null = null;
let stopSettingsIpc: (() => void) | null = null;
let stopAssistantIpc: (() => void) | null = null;
let stopReportsIpc: (() => void) | null = null;
let aiWorker: AIAnalysisWorker | null = null;
let quarantine: QuarantineManager | null = null;
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
  stopQuarantineIpc?.();
  stopQuarantineIpc = null;
  stopSettingsIpc?.();
  stopSettingsIpc = null;
  stopAssistantIpc?.();
  stopAssistantIpc = null;
  stopReportsIpc?.();
  stopReportsIpc = null;
  stopDialogIpc?.();
  stopDialogIpc = null;
  void Promise.allSettled([
    stopScanIpc?.() ?? Promise.resolve(),
    aiWorker?.stop() ?? Promise.resolve(),
    quarantine?.close() ?? Promise.resolve(),
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
    const uiConfirmation = new QuarantineUIConfirmation();
    quarantine = createQuarantineManager(database, uiConfirmation.confirm);
    await quarantine.reconcile();
    if (quitting) return;
    aiWorker = createAIWorkflow(database);
    aiWorker.on('workerError', () =>
      console.error('El worker de IA se ha pausado.'),
    );
    aiWorker.start();
    const trustedRendererUrl = pathToFileURL(rendererPath).href;
    stopQuarantineIpc = registerQuarantineIpc(
      () => mainWindow,
      trustedRendererUrl,
      quarantine,
      database,
      uiConfirmation,
    );
    stopSettingsIpc = registerSettingsIpc(
      () => mainWindow,
      trustedRendererUrl,
      createAISettings(database, { onReady: () => aiWorker?.resume() }),
    );
    const db = database;
    const reports = new ReportBuilder(db);
    stopReportsIpc = registerReportsIpc(
      () => mainWindow,
      trustedRendererUrl,
      reports,
    );
    stopAssistantIpc = registerAssistantIpc(
      () => mainWindow,
      trustedRendererUrl,
      new AssistantOrchestrator({
        db,
        // Por pregunta: usa siempre la API key y la configuración vigentes.
        provider: () => createAIProvider(db),
        readConfig: () => new AppConfigStore(db).load(),
      }),
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

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  quit: vi.fn(),
  getPath: vi.fn(() => 'injected-user-data'),
  createDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  reconnect: vi.fn(),
  closeEngine: vi.fn(),
  createMainWindow: vi.fn(),
  registerSystemIpc: vi.fn(),
  createScanOrchestrator: vi.fn(),
  registerDialogIpc: vi.fn(),
  registerScanIpc: vi.fn(),
  stopDialogIpc: vi.fn(),
  stopScanIpc: vi.fn(),
  createAISettings: vi.fn(),
  registerSettingsIpc: vi.fn(),
  registerQuarantineIpc: vi.fn(),
  stopQuarantineIpc: vi.fn(),
  stopSettingsIpc: vi.fn(),
  registerAssistantIpc: vi.fn(),
  stopAssistantIpc: vi.fn(),
  registerReportsIpc: vi.fn(),
  stopReportsIpc: vi.fn(),
  createAIProvider: vi.fn(),
  createAIWorkflow: vi.fn(),
  startAI: vi.fn(),
  stopAI: vi.fn(),
  resumeAI: vi.fn(),
  reconcileQuarantine: vi.fn(),
  closeQuarantine: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    on: mocks.on,
    quit: mocks.quit,
    getPath: mocks.getPath,
    getAppPath: () => '.',
    whenReady: () => Promise.resolve(),
  },
}));
vi.mock('../src/main/composition-root', () => ({
  createDatabase: mocks.createDatabase,
  createScanOrchestrator: mocks.createScanOrchestrator,
  createAISettings: mocks.createAISettings,
  createAIWorkflow: mocks.createAIWorkflow,
  createAIProvider: mocks.createAIProvider,
  createQuarantineManager: () => ({
    reconcile: mocks.reconcileQuarantine,
    close: mocks.closeQuarantine,
  }),
  createEngine: () => ({
    close: mocks.closeEngine,
    reconnect: mocks.reconnect,
  }),
}));
vi.mock('../src/main/window', () => ({
  createMainWindow: mocks.createMainWindow,
}));
vi.mock('../src/main/ipc/system.ipc', () => ({
  registerSystemIpc: mocks.registerSystemIpc,
}));
vi.mock('../src/main/ipc/dialog.ipc', () => ({
  registerDialogIpc: mocks.registerDialogIpc,
}));
vi.mock('../src/main/ipc/scan.ipc', () => ({
  registerScanIpc: mocks.registerScanIpc,
}));
vi.mock('../src/main/ipc/quarantine.ipc', () => ({
  registerQuarantineIpc: mocks.registerQuarantineIpc,
  QuarantineUIConfirmation: class {
    confirm = vi.fn();
  },
}));
vi.mock('../src/main/ipc/settings.ipc', () => ({
  registerSettingsIpc: mocks.registerSettingsIpc,
}));
vi.mock('../src/main/ipc/assistant.ipc', () => ({
  registerAssistantIpc: mocks.registerAssistantIpc,
}));
vi.mock('../src/main/ipc/reports.ipc', () => ({
  registerReportsIpc: mocks.registerReportsIpc,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.createDatabase.mockReturnValue({ close: mocks.closeDatabase });
  mocks.createAIWorkflow.mockReturnValue({
    start: mocks.startAI,
    stop: mocks.stopAI,
    resume: mocks.resumeAI,
    on: vi.fn(),
  });
  mocks.stopAI.mockResolvedValue(undefined);
  mocks.reconcileQuarantine.mockResolvedValue(undefined);
  mocks.closeQuarantine.mockResolvedValue(undefined);
  mocks.createScanOrchestrator.mockReturnValue({ marker: 'scan' });
  mocks.registerDialogIpc.mockReturnValue(mocks.stopDialogIpc);
  mocks.createAISettings.mockReturnValue({ marker: 'settings' });
  mocks.registerSettingsIpc.mockReturnValue(mocks.stopSettingsIpc);
  mocks.registerAssistantIpc.mockReturnValue(mocks.stopAssistantIpc);
  mocks.registerReportsIpc.mockReturnValue(mocks.stopReportsIpc);
  mocks.registerScanIpc.mockReturnValue(mocks.stopScanIpc);
  mocks.registerQuarantineIpc.mockReturnValue(mocks.stopQuarantineIpc);
  mocks.stopScanIpc.mockResolvedValue(undefined);
  mocks.createMainWindow.mockReturnValue({
    on: vi.fn(),
    loadFile: vi.fn().mockResolvedValue(undefined),
  });
  mocks.reconnect.mockResolvedValue(undefined);
  mocks.closeEngine.mockResolvedValue(undefined);
});

it('migra antes de abrir la ventana y cierra la BD solo al terminar el cierre del motor', async () => {
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  expect(mocks.getPath).toHaveBeenCalledWith('userData');
  expect(mocks.createDatabase).toHaveBeenCalledWith('injected-user-data');
  expect(mocks.startAI).toHaveBeenCalledOnce();
  expect(mocks.createDatabase.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.startAI.mock.invocationCallOrder[0]!,
  );
  mocks.createAISettings.mock.calls[0]![1].onReady();
  expect(mocks.resumeAI).toHaveBeenCalledOnce();
  expect(mocks.createScanOrchestrator.mock.calls[0]![2]).toBe(
    mocks.createAIWorkflow.mock.results[0]!.value,
  );
  expect(mocks.registerScanIpc).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.stringContaining('index.html'),
    { marker: 'scan' },
    { close: mocks.closeDatabase },
    mocks.createAIWorkflow.mock.results[0]!.value,
  );
  expect(mocks.registerDialogIpc).toHaveBeenCalledOnce();
  expect(mocks.registerReportsIpc).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.stringContaining('index.html'),
    expect.objectContaining({
      build: expect.any(Function),
      get: expect.any(Function),
    }),
  );
  expect(mocks.registerReportsIpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.createMainWindow.mock.invocationCallOrder[0]!,
  );
  expect(mocks.registerQuarantineIpc).toHaveBeenCalledOnce();
  expect(
    mocks.registerQuarantineIpc.mock.invocationCallOrder[0],
  ).toBeGreaterThan(mocks.reconcileQuarantine.mock.invocationCallOrder[0]!);
  expect(mocks.registerSettingsIpc).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.stringContaining('index.html'),
    { marker: 'settings' },
  );
  // T4.6: el SOC Copilot se registra antes de abrir la ventana con el orquestador del core.
  expect(mocks.registerAssistantIpc).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.stringContaining('index.html'),
    expect.objectContaining({
      ask: expect.any(Function),
      reset: expect.any(Function),
    }),
  );
  expect(mocks.registerAssistantIpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.createMainWindow.mock.invocationCallOrder[0]!,
  );
  expect(mocks.createAIProvider).not.toHaveBeenCalled(); // solo se crea al preguntar
  expect(mocks.registerScanIpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.createMainWindow.mock.invocationCallOrder[0]!,
  );
  expect(mocks.createDatabase.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.createMainWindow.mock.invocationCallOrder[0]!,
  );
  const handler = (name: string) =>
    mocks.on.mock.calls.find(([event]) => event === name)![1];
  handler('before-quit')({ preventDefault: vi.fn() });
  expect(mocks.closeDatabase).not.toHaveBeenCalled();
  expect(mocks.stopScanIpc).toHaveBeenCalledOnce();
  expect(mocks.stopDialogIpc).toHaveBeenCalledOnce();
  expect(mocks.stopSettingsIpc).toHaveBeenCalledOnce();
  expect(mocks.stopAssistantIpc).toHaveBeenCalledOnce();
  expect(mocks.stopReportsIpc).toHaveBeenCalledOnce();
  expect(mocks.stopQuarantineIpc).toHaveBeenCalledOnce();
  expect(mocks.stopQuarantineIpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.closeQuarantine.mock.invocationCallOrder[0]!,
  );
  expect(mocks.stopAI).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
  handler('will-quit')();
  expect(mocks.closeDatabase).toHaveBeenCalledOnce();
  handler('will-quit')();
  expect(mocks.closeDatabase).toHaveBeenCalledOnce();
});

it('espera la cancelación de IA antes de cerrar motor y SQLite', async () => {
  let finish!: () => void;
  mocks.stopAI.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  const handler = mocks.on.mock.calls.find(
    ([name]) => name === 'before-quit',
  )![1];
  handler({ preventDefault: vi.fn() });
  await Promise.resolve();
  expect(mocks.closeEngine).not.toHaveBeenCalled();
  expect(mocks.closeDatabase).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
});

it('espera a cancelar el escaneo antes de cerrar motor y BD', async () => {
  let finishScan!: () => void;
  mocks.stopScanIpc.mockReturnValue(
    new Promise<void>((resolve) => {
      finishScan = resolve;
    }),
  );
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  const beforeQuit = mocks.on.mock.calls.find(
    ([name]) => name === 'before-quit',
  )![1];
  beforeQuit({ preventDefault: vi.fn() });
  beforeQuit({ preventDefault: vi.fn() });
  expect(mocks.stopScanIpc).toHaveBeenCalledOnce();
  expect(mocks.closeEngine).not.toHaveBeenCalled();
  expect(mocks.closeDatabase).not.toHaveBeenCalled();
  expect(mocks.quit).not.toHaveBeenCalled();
  finishScan();
  await vi.waitFor(() => expect(mocks.closeEngine).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
});

it('no abre la ventana si falla la inicializacion de la BD', async () => {
  mocks.createDatabase.mockImplementationOnce(() => {
    throw new Error('SQLite no disponible');
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await import('../src/main/index');
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
    expect(mocks.createMainWindow).not.toHaveBeenCalled();
    expect(mocks.reconnect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('espera la reconciliación antes de abrir ventana e iniciar IA', async () => {
  let finish!: () => void;
  mocks.reconcileQuarantine.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await import('../src/main/index');
  await vi.waitFor(() =>
    expect(mocks.reconcileQuarantine).toHaveBeenCalledOnce(),
  );
  expect(mocks.createMainWindow).not.toHaveBeenCalled();
  expect(mocks.startAI).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
});

it('espera las operaciones de cuarentena antes de cerrar SQLite y el motor', async () => {
  let finish!: () => void;
  mocks.closeQuarantine.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await import('../src/main/index');
  await vi.waitFor(() => expect(mocks.createMainWindow).toHaveBeenCalledOnce());
  mocks.on.mock.calls.find(([event]) => event === 'before-quit')![1]({
    preventDefault: vi.fn(),
  });
  expect(mocks.closeQuarantine).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(mocks.closeEngine).not.toHaveBeenCalled();
  expect(mocks.closeDatabase).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
});

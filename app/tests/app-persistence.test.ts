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

beforeEach(() => {
  vi.resetModules();
  mocks.createDatabase.mockReturnValue({ close: mocks.closeDatabase });
  mocks.createScanOrchestrator.mockReturnValue({ marker: 'scan' });
  mocks.registerDialogIpc.mockReturnValue(mocks.stopDialogIpc);
  mocks.registerScanIpc.mockReturnValue(mocks.stopScanIpc);
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
  expect(mocks.registerScanIpc).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.stringContaining('index.html'),
    { marker: 'scan' },
    { close: mocks.closeDatabase },
  );
  expect(mocks.registerDialogIpc).toHaveBeenCalledOnce();
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
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
  handler('will-quit')();
  expect(mocks.closeDatabase).toHaveBeenCalledOnce();
  handler('will-quit')();
  expect(mocks.closeDatabase).toHaveBeenCalledOnce();
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

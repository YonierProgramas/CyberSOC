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

beforeEach(() => {
  vi.resetModules();
  mocks.createDatabase.mockReturnValue({ close: mocks.closeDatabase });
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
  expect(mocks.createDatabase.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.createMainWindow.mock.invocationCallOrder[0]!,
  );
  const handler = (name: string) =>
    mocks.on.mock.calls.find(([event]) => event === name)![1];
  handler('before-quit')({ preventDefault: vi.fn() });
  expect(mocks.closeDatabase).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
  handler('will-quit')();
  expect(mocks.closeDatabase).toHaveBeenCalledOnce();
  handler('will-quit')();
  expect(mocks.closeDatabase).toHaveBeenCalledOnce();
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

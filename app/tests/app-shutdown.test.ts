import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  quit: vi.fn(),
  close: vi.fn(),
  reconnect: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    on: mocks.on,
    quit: mocks.quit,
    getAppPath: () => '.',
    whenReady: () => new Promise(() => {}),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
}));
vi.mock('../src/main/composition-root', () => ({
  createEngine: () => ({ close: mocks.close, reconnect: mocks.reconnect }),
}));

it('before-quit espera al cierre del motor y evita cierres simultaneos', async () => {
  let finish!: () => void;
  mocks.close.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await import('../src/main/index');
  const beforeQuit = mocks.on.mock.calls.find(
    ([name]) => name === 'before-quit',
  )![1] as (event: { preventDefault(): void }) => void;
  const event = { preventDefault: vi.fn() };
  beforeQuit(event);
  beforeQuit(event);
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  expect(mocks.quit).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
  const lastEvent = { preventDefault: vi.fn() };
  beforeQuit(lastEvent);
  expect(lastEvent.preventDefault).not.toHaveBeenCalled();
});

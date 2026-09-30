import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  SYSTEM_GET_STATUS,
  SYSTEM_RECONNECT_ENGINE,
  type EngineState,
} from '../src/shared/ipc';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  getVersion: vi.fn(() => '0.0.1'),
}));

vi.mock('electron', () => ({
  app: { getVersion: electron.getVersion },
  ipcMain: { handle: electron.handle },
}));

import { registerSystemIpc } from '../src/main/ipc/system.ipc';

describe('system:getStatus', () => {
  const state: EngineState = {
    status: 'disconnected',
    engineVersion: null,
    protocol: null,
  };
  const engine = {
    getState: vi.fn((): EngineState => state),
    reconnect: vi.fn(async () => state),
  };
  const trustedUrl = 'file:///cybersoc/out/renderer/index.html';
  const mainFrame = { url: trustedUrl };
  const webContents = { mainFrame };
  const window = { webContents } as unknown as BrowserWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    mainFrame.url = trustedUrl;
  });

  function handler(getWindow: () => BrowserWindow | null = () => window) {
    registerSystemIpc(getWindow, trustedUrl, engine);
    expect(electron.handle).toHaveBeenCalledWith(
      SYSTEM_GET_STATUS,
      expect.any(Function),
    );
    return electron.handle.mock.calls[0]![1] as (
      event: IpcMainInvokeEvent,
    ) => unknown;
  }

  it('devuelve nombre y version al frame principal de la ventana autorizada', () => {
    expect(
      handler()({
        sender: webContents,
        senderFrame: mainFrame,
      } as IpcMainInvokeEvent),
    ).toEqual({ app: 'CyberSOC Defender', version: '0.0.1', engine: state });
  });

  it('rechaza otra ventana', () => {
    expect(() =>
      handler()({ sender: {}, senderFrame: mainFrame } as IpcMainInvokeEvent),
    ).toThrow('Origen IPC no autorizado');
  });

  it('rechaza argumentos antes de consultar el motor', () => {
    const call = handler() as (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown;
    expect(() =>
      call(
        { sender: webContents, senderFrame: mainFrame } as IpcMainInvokeEvent,
        { command: 'untrusted' },
      ),
    ).toThrow();
    expect(engine.getState).not.toHaveBeenCalled();
  });

  it('valida origen y argumentos tambien en reconnectEngine', async () => {
    handler();
    const call = electron.handle.mock.calls.find(
      ([channel]) => channel === SYSTEM_RECONNECT_ENGINE,
    )![1] as (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<unknown>;
    const event = {
      sender: webContents,
      senderFrame: mainFrame,
    } as IpcMainInvokeEvent;
    await expect(call({} as IpcMainInvokeEvent)).rejects.toThrow('Origen IPC');
    await expect(call(event, 'bad')).rejects.toThrow();
    expect(engine.reconnect).not.toHaveBeenCalled();
    await expect(call(event)).resolves.toMatchObject({ engine: state });
    expect(engine.reconnect).toHaveBeenCalledOnce();
  });

  it('rechaza un estado invalido del motor antes de enviarlo al renderer', () => {
    engine.getState.mockReturnValueOnce({
      status: 'connected',
      engineVersion: 'x',
      protocol: '2',
    } as unknown as EngineState);
    expect(() =>
      handler()({
        sender: webContents,
        senderFrame: mainFrame,
      } as IpcMainInvokeEvent),
    ).toThrow();
  });

  it('rechaza subframes', () => {
    expect(() =>
      handler()({ sender: webContents, senderFrame: {} } as IpcMainInvokeEvent),
    ).toThrow('Origen IPC no autorizado');
  });

  it('rechaza peticiones cuando no hay ventana', () => {
    expect(() => handler(() => null)({} as IpcMainInvokeEvent)).toThrow(
      'Origen IPC no autorizado',
    );
  });

  it('rechaza una URL distinta aunque use el frame principal', () => {
    mainFrame.url = 'about:blank';
    expect(() =>
      handler()({
        sender: webContents,
        senderFrame: mainFrame,
      } as IpcMainInvokeEvent),
    ).toThrow('Origen IPC no autorizado');
  });
});

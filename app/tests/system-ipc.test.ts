import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { SYSTEM_GET_STATUS } from '../src/shared/ipc';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  getVersion: vi.fn(() => '0.0.1'),
}));

vi.mock('electron', () => ({
  app: { getVersion: electron.getVersion },
  ipcMain: { handle: electron.handle },
}));

import { registerSystemIpc } from '../src/main/ipc/system.ipc';

describe('system:get-status', () => {
  const trustedUrl = 'file:///cybersoc/out/renderer/index.html';
  const mainFrame = { url: trustedUrl };
  const webContents = { mainFrame };
  const window = { webContents } as unknown as BrowserWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    mainFrame.url = trustedUrl;
  });

  function handler(getWindow: () => BrowserWindow | null = () => window) {
    registerSystemIpc(getWindow, trustedUrl);
    expect(electron.handle).toHaveBeenCalledExactlyOnceWith(
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
    ).toEqual({ app: 'CyberSOC Defender', version: '0.0.1' });
  });

  it('rechaza otra ventana', () => {
    expect(() =>
      handler()({ sender: {}, senderFrame: mainFrame } as IpcMainInvokeEvent),
    ).toThrow('Origen IPC no autorizado');
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

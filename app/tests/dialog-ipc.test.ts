import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  dialog: { showOpenDialog: electron.showOpenDialog },
}));
import { registerDialogIpc } from '../src/main/ipc/dialog.ipc';
import { existingScanTarget } from '../src/main/ipc/scan-validation';

describe('dialog IPC and target validation', () => {
  let directory: string;
  let file: string;
  const trustedUrl = 'file:///cybersoc/out/renderer/index.html';
  const mainFrame = { url: trustedUrl };
  const webContents = { mainFrame, isDestroyed: vi.fn(() => false) };
  const window = {
    webContents,
    isDestroyed: vi.fn(() => false),
  } as unknown as BrowserWindow;
  const event = {
    sender: webContents,
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-dialog-'));
    file = join(directory, 'niño á 😀.txt');
    writeFileSync(file, 'benigno');
    mainFrame.url = trustedUrl;
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function handler(channel: string) {
    registerDialogIpc(() => window, trustedUrl);
    return electron.handle.mock.calls.find(
      ([name]) => name === channel,
    )![1] as (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<string | null>;
  }

  it.each([
    ['dialog:selectFolder', 'openDirectory'],
    ['dialog:selectFile', 'openFile'],
  ])('opens %s with parent and single selection', async (channel, property) => {
    const selected = property === 'openDirectory' ? directory : file;
    electron.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [selected],
    });
    await expect(handler(channel!)(event)).resolves.toBe(selected);
    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ properties: [property] }),
    );
  });

  it('cancelling the dialog returns null', async () => {
    electron.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    await expect(handler('dialog:selectFile')(event)).resolves.toBeNull();
  });

  it('rejects unauthorized arguments and senders before the dialog', async () => {
    const call = handler('dialog:selectFile');
    await expect(call(event, 'unexpected')).rejects.toThrow();
    await expect(
      call({ ...event, sender: {} } as IpcMainInvokeEvent),
    ).rejects.toThrow('Origen IPC');
    await expect(
      call({ ...event, senderFrame: {} } as IpcMainInvokeEvent),
    ).rejects.toThrow('Origen IPC');
    mainFrame.url = 'about:blank';
    await expect(call(event)).rejects.toThrow('Origen IPC');
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });

  it('delivers no paths if the renderer navigated while waiting for the dialog', async () => {
    electron.showOpenDialog.mockImplementationOnce(async () => {
      mainFrame.url = 'about:blank';
      return { canceled: false, filePaths: [file] };
    });
    await expect(handler('dialog:selectFile')(event)).rejects.toThrow(
      'Origen IPC',
    );
  });

  it('validates absolute, existing paths of the requested type', async () => {
    await expect(
      existingScanTarget({ kind: 'FILE', path: file }),
    ).resolves.toEqual({ kind: 'FILE', path: file });
    await expect(
      existingScanTarget({ kind: 'FOLDER', path: directory }),
    ).resolves.toEqual({ kind: 'FOLDER', path: directory });
    for (const input of [
      { kind: 'FILE', path: 'relative.txt' },
      { kind: 'FILE', path: file + '\0' },
      { kind: 'FILE', path: join(directory, 'missing') },
      { kind: 'FILE', path: directory },
      { kind: 'FOLDER', path: file },
      { kind: 'FILE', path: file, command: 'extra' },
      { kind: 'OTHER', path: file },
    ])
      await expect(existingScanTarget(input)).rejects.toThrow();
  });

  it('removes handlers when unmounting the registration', () => {
    registerDialogIpc(() => window, trustedUrl)();
    expect(electron.removeHandler.mock.calls).toEqual([
      ['dialog:selectFolder'],
      ['dialog:selectFile'],
    ]);
  });
});

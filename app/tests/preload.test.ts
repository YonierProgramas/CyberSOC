import { expect, it, vi } from 'vitest';
import type { CyberSocApi } from '../src/shared/ipc';

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke },
}));

it('expone solo getStatus y reconnectEngine con canales IPC fijos', async () => {
  await import('../src/preload/index');
  expect(electron.expose).toHaveBeenCalledExactlyOnceWith(
    'cybersoc',
    expect.any(Object),
  );
  const api = electron.expose.mock.calls[0]![1] as CyberSocApi;
  expect(Object.keys(api)).toEqual(['system']);
  expect(Object.keys(api.system)).toEqual(['getStatus', 'reconnectEngine']);

  const status = { app: 'CyberSOC Defender', version: '0.0.1' };
  electron.invoke.mockResolvedValue(status);
  await expect(api.system.getStatus()).resolves.toEqual(status);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('system:getStatus');
  await expect(api.system.reconnectEngine()).resolves.toEqual(status);
  expect(electron.invoke).toHaveBeenLastCalledWith('system:reconnectEngine');
});

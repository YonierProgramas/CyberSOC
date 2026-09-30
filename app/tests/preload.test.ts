import { expect, it, vi } from 'vitest';
import type { CyberSocApi } from '../src/shared/ipc';

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

it('expone solo system, dialog y scan con métodos y canales fijos', async () => {
  await import('../src/preload/index');
  expect(electron.expose).toHaveBeenCalledExactlyOnceWith(
    'cybersoc',
    expect.any(Object),
  );
  const api = electron.expose.mock.calls[0]![1] as CyberSocApi;
  expect(Object.keys(api).sort()).toEqual(['dialog', 'scan', 'system']);
  expect(Object.keys(api.dialog)).toEqual(['selectFolder', 'selectFile']);
  expect(Object.keys(api.scan)).toEqual([
    'start',
    'cancel',
    'getJob',
    'listJobs',
    'listResults',
    'onProgress',
    'onFinished',
  ]);
  expect(Object.keys(api.system)).toEqual(['getStatus', 'reconnectEngine']);

  const status = { app: 'CyberSOC Defender', version: '0.0.1' };
  electron.invoke.mockResolvedValue(status);
  await expect(api.system.getStatus()).resolves.toEqual(status);
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('system:getStatus');
  await expect(api.system.reconnectEngine()).resolves.toEqual(status);
  expect(electron.invoke).toHaveBeenLastCalledWith('system:reconnectEngine');
  await api.dialog.selectFolder();
  expect(electron.invoke).toHaveBeenLastCalledWith('dialog:selectFolder');
  await api.dialog.selectFile();
  expect(electron.invoke).toHaveBeenLastCalledWith('dialog:selectFile');
  const target = { kind: 'FILE', path: 'C:\\ñ.txt' } as const;
  await api.scan.start(target);
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:start', target);
  await api.scan.cancel('j1');
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:cancel', 'j1');
  await api.scan.getJob('j1');
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:getJob', 'j1');
  await api.scan.listJobs();
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:listJobs');
  await api.scan.listJobs(10);
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:listJobs', 10);
  const query = { jobId: 'j1', offset: 0, limit: 200 };
  await api.scan.listResults(query);
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:listResults', query);

  for (const [subscribe, channel] of [
    [api.scan.onProgress, 'scan:progress'],
    [api.scan.onFinished, 'scan:finished'],
  ] as const) {
    const callback = vi.fn();
    const unsubscribe = subscribe(callback);
    const listener = electron.on.mock.calls.at(-1)![1];
    const payload = { marker: 'payload' };
    listener({ sender: 'must stay private' }, payload);
    expect(callback).toHaveBeenCalledExactlyOnceWith(payload);
    unsubscribe();
    unsubscribe();
    expect(electron.removeListener).toHaveBeenLastCalledWith(channel, listener);
    listener({}, payload);
    expect(callback).toHaveBeenCalledTimes(1);
  }
});

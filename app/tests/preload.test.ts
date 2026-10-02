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

it('expone system, dialog, scan, settings.ai y assistant con métodos y canales fijos', async () => {
  await import('../src/preload/index');
  expect(electron.expose).toHaveBeenCalledExactlyOnceWith(
    'cybersoc',
    expect.any(Object),
  );
  const api = electron.expose.mock.calls[0]![1] as CyberSocApi;
  expect(Object.keys(api).sort()).toEqual([
    'assistant',
    'dialog',
    'quarantine',
    'scan',
    'settings',
    'system',
  ]);
  expect(Object.keys(api.settings)).toEqual(['ai']);
  expect(Object.keys(api.settings.ai)).toEqual([
    'setApiKey',
    'clearApiKey',
    'getStatus',
    'testConnection',
  ]);
  await api.settings.ai.setApiKey('unit-test-placeholder');
  expect(electron.invoke).toHaveBeenLastCalledWith(
    'settings.ai:setApiKey',
    'unit-test-placeholder',
  );
  await api.settings.ai.clearApiKey();
  expect(electron.invoke).toHaveBeenLastCalledWith('settings.ai:clearApiKey');
  await api.settings.ai.getStatus();
  expect(electron.invoke).toHaveBeenLastCalledWith('settings.ai:getStatus');
  await api.settings.ai.testConnection();
  expect(electron.invoke).toHaveBeenLastCalledWith(
    'settings.ai:testConnection',
  );
  electron.invoke.mockClear();
  expect(Object.keys(api.dialog)).toEqual(['selectFolder', 'selectFile']);
  expect(Object.keys(api.scan)).toEqual([
    'start',
    'cancel',
    'getJob',
    'listJobs',
    'listResults',
    'getResult',
    'getJobSummary',
    'analyzeNow',
    'onProgress',
    'onFinished',
    'onResultUpdated',
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
  await api.scan.getResult('r1');
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:getResult', 'r1');
  await api.scan.getJobSummary('j1');
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:getJobSummary', 'j1');
  await api.scan.analyzeNow('r1');
  expect(electron.invoke).toHaveBeenLastCalledWith('scan:analyzeNow', 'r1');
  expect(Object.keys(api.assistant)).toEqual([
    'listConversations',
    'openConversation',
    'ask',
    'reset',
  ]);
  await api.assistant.listConversations();
  expect(electron.invoke).toHaveBeenLastCalledWith(
    'assistant:listConversations',
  );
  await api.assistant.listConversations({ limit: 10, offset: 2 });
  expect(electron.invoke).toHaveBeenLastCalledWith(
    'assistant:listConversations',
    { limit: 10, offset: 2 },
  );
  await api.assistant.openConversation('conversation-id');
  expect(electron.invoke).toHaveBeenLastCalledWith(
    'assistant:openConversation',
    'conversation-id',
  );
  const question = {
    message: '¿Por qué fue marcado?',
    focus: { resultId: 'r1' },
  };
  await api.assistant.ask(question);
  expect(electron.invoke).toHaveBeenLastCalledWith('assistant:ask', question);
  await api.assistant.reset();
  expect(electron.invoke).toHaveBeenLastCalledWith('assistant:reset');

  expect(Object.keys(api.quarantine)).toEqual([
    'list',
    'quarantine',
    'restore',
    'delete',
    'onChanged',
  ]);
  await api.quarantine.list();
  expect(electron.invoke).toHaveBeenLastCalledWith('quarantine:list');
  await api.quarantine.list({ status: 'QUARANTINED' });
  expect(electron.invoke).toHaveBeenLastCalledWith('quarantine:list', {
    status: 'QUARANTINED',
  });
  await api.quarantine.quarantine('r1');
  expect(electron.invoke).toHaveBeenLastCalledWith(
    'quarantine:quarantine',
    'r1',
  );
  await api.quarantine.restore('q1', {
    trustHash: false,
    targetPath: 'C:\\restored.txt',
  });
  expect(electron.invoke).toHaveBeenLastCalledWith('quarantine:restore', 'q1', {
    trustHash: false,
    targetPath: 'C:\\restored.txt',
  });
  await api.quarantine.delete('q1');
  expect(electron.invoke).toHaveBeenLastCalledWith('quarantine:delete', 'q1');

  for (const [subscribe, channel] of [
    [api.quarantine.onChanged, 'quarantine:changed'],
    [api.scan.onProgress, 'scan:progress'],
    [api.scan.onFinished, 'scan:finished'],
    [api.scan.onResultUpdated, 'ai:resultUpdated'],
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

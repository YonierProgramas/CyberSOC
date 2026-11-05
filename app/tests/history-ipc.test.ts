import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  registerHistoryIpc,
  type HistoryService,
} from '../src/main/ipc/history.ipc';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { DashboardReader } from '../src/core/dashboard/DashboardReader';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ConversationRepository } from '../src/core/persistence/ConversationRepository';
import { ConversationArchiveReader } from '../src/core/persistence/ConversationArchiveReader';
import { seedHistory, seedMessages } from './fixtures/history';
const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: electron }));
const url = 'file:///cybersoc/renderer/index.html';
const frame = { url };
const webContents = { mainFrame: frame, isDestroyed: () => false };
const window = {
  webContents,
  isDestroyed: () => false,
} as unknown as BrowserWindow;
const event = {
  sender: webContents,
  senderFrame: frame,
} as unknown as IpcMainInvokeEvent;
let root: string,
  db: Database,
  service: HistoryService,
  chat: string,
  stop: () => void;
const channels = [
  'dashboard:getOverview',
  'scan:listJobsPage',
  'assistant:listConversationsPage',
  'assistant:listMessages',
];
beforeEach(() => {
  vi.clearAllMocks();
  frame.url = url;
  root = mkdtempSync(join(tmpdir(), 'cybersoc-history-ipc-'));
  db = new Database(join(root, 'fixture.sqlite'));
  new MigrationRunner(db).run();
  seedHistory(db, 3, 6);
  chat = seedMessages(db, 6);
  service = {
    getOverview: (query) => new DashboardReader(db).getOverview(query),
    listJobsPage: (query) => new ScanJobRepository(db).listPage(query),
    listConversationsPage: (query) =>
      new ConversationRepository(db).listPage(query),
    listMessages: (query) =>
      new ConversationArchiveReader(db).listMessages(query),
  };
  stop = registerHistoryIpc(() => window, url, service);
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function call(
  channel: string,
  sender: unknown = event,
  ...args: unknown[]
): Promise<unknown> {
  return Promise.resolve().then(() =>
    electron.handle.mock.calls.find(([name]) => name === channel)![1](
      sender,
      ...args,
    ),
  );
}
function validArgs(channel: string): unknown[] {
  return channel === 'dashboard:getOverview'
    ? []
    : channel === 'assistant:listMessages'
      ? [{ conversationId: chat }]
      : [{ offset: 0, limit: 20 }];
}
it('I-01/I-12: registra solo cuatro canales aditivos con respuestas de SQLite real', async () => {
  expect(electron.handle.mock.calls.map(([name]) => name)).toEqual(channels);
  await expect(call(channels[0]!)).resolves.toMatchObject({
    schema: 'cybersoc.dashboard/v1',
    allTime: { jobs: 3, results: 6 },
  });
  await expect(
    call(channels[1]!, event, ...validArgs(channels[1]!)),
  ).resolves.toMatchObject({ total: 3 });
  await expect(
    call(channels[2]!, event, ...validArgs(channels[2]!)),
  ).resolves.toMatchObject({ total: 1 });
  await expect(
    call(channels[3]!, event, ...validArgs(channels[3]!)),
  ).resolves.toMatchObject({ conversationId: chat, total: 6 });
});
it('I-12: otra ventana/subframe/navegación y argumentos extra/tipos inválidos fallan sin leer', async () => {
  const reads = Object.keys(service).map((name) =>
    vi.spyOn(service, name as keyof HistoryService),
  );
  for (const channel of channels) {
    for (const sender of [
      { sender: {}, senderFrame: frame },
      { sender: webContents, senderFrame: { url } },
    ])
      await expect(
        call(channel, sender, ...validArgs(channel)),
      ).rejects.toThrow();
    await expect(
      call(channel, event, ...validArgs(channel), 'extra'),
    ).rejects.toThrow();
    await expect(
      call(channel, event, 'JSON falso con C:\\privado'),
    ).rejects.toThrow();
    const extra =
      channel === 'dashboard:getOverview'
        ? { extra: true }
        : channel === 'assistant:listMessages'
          ? { conversationId: chat, extra: true }
          : { offset: 0, limit: 20, extra: true };
    await expect(call(channel, event, extra)).rejects.toThrow();
  }
  frame.url = 'https://untrusted.invalid/';
  for (const channel of channels)
    await expect(call(channel, event, ...validArgs(channel))).rejects.toThrow();
  for (const read of reads) expect(read).not.toHaveBeenCalled();
});
it('I-12: errores y salidas inválidas no filtran datos; INVALID_RANGE estable sin parcial', async () => {
  const privateMessage = 'C:\\privado\\secreto.sqlite: pregunta e input';
  vi.spyOn(service, 'listMessages').mockImplementation(() => {
    throw new Error(privateMessage);
  });
  await expect(
    call('assistant:listMessages', event, { conversationId: chat }),
  ).rejects.toThrow('No se pudo consultar el archivo de mensajes.');
  vi.spyOn(service, 'listJobsPage').mockReturnValue({
    items: [],
    offset: 0,
    limit: 20,
    total: 0,
    sql: privateMessage,
  } as never);
  await expect(
    call('scan:listJobsPage', event, { offset: 0, limit: 20 }),
  ).rejects.toThrow('No se pudo consultar el historial de análisis.');
  await expect(
    call('dashboard:getOverview', event, {
      from: '2024-01-01',
      to: '2025-01-01',
    }),
  ).rejects.toThrow('INVALID_RANGE');
  for (const channel of channels) {
    stop();
    await expect(call(channel, event, ...validArgs(channel))).rejects.toThrow();
  }
  expect(electron.removeHandler.mock.calls.map(([name]) => name)).toEqual(
    expect.arrayContaining(channels),
  );
});

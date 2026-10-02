import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ReportBuilder } from '../src/core/reports/ReportBuilder';
import { registerReportsIpc } from '../src/main/ipc/reports.ipc';
import { seedReports } from './report-fixtures';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  save: vi.fn(),
  write: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler },
  dialog: { showSaveDialog: mocks.save },
}));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }));
const url = 'file:///app/index.html';
const frame = { url };
const contents = { mainFrame: frame, isDestroyed: () => false };
const window = {
  webContents: contents,
  isDestroyed: () => false,
} as unknown as BrowserWindow;
const event = {
  sender: contents,
  senderFrame: frame,
} as unknown as IpcMainInvokeEvent;
let db: Database,
  root: string,
  builder: ReportBuilder,
  id: string,
  stop: () => void;
let handler: (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  frame.url = url;
  root = mkdtempSync(join(tmpdir(), 'cybersoc-report-ipc-'));
  db = new Database(join(root, 'test.db'));
  new MigrationRunner(db).run();
  seedReports(db);
  builder = new ReportBuilder(db);
  id = builder.build().reportDraftId;
  mocks.save.mockResolvedValue({
    canceled: false,
    filePath: join(root, 'out.html'),
  });
  mocks.write.mockResolvedValue(undefined);
  stop = registerReportsIpc(() => window, url, builder);
  handler = mocks.handle.mock.calls[0]![1];
});
afterEach(() => {
  stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it.each(['html', 'csv', 'json'] as const)(
  'solo guarda %s después de aceptar el diálogo',
  async (format) => {
    let resolve!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const request = handler(event, { reportDraftId: id, format });
    expect(mocks.write).not.toHaveBeenCalled();
    resolve({ canceled: false, filePath: join(root, `out.${format}`) });
    await expect(request).resolves.toEqual({ status: 'SAVED' });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      join(root, `out.${format}`),
      expect.any(String),
      'utf8',
    );
    expect(mocks.save).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        properties: ['showOverwriteConfirmation'],
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      }),
    );
  },
);
it('cancelación no escribe y un ID inexistente no abre el diálogo', async () => {
  mocks.save.mockResolvedValueOnce({ canceled: true });
  await expect(
    handler(event, { reportDraftId: id, format: 'html' }),
  ).resolves.toEqual({ status: 'CANCELLED' });
  expect(mocks.write).not.toHaveBeenCalled();
  await expect(
    handler(event, {
      reportDraftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      format: 'html',
    }),
  ).rejects.toThrow('No se pudo exportar');
  expect(mocks.save).toHaveBeenCalledTimes(1);
});
it.each([
  {},
  { reportDraftId: 'invalid', format: 'html' },
  { format: 'exe' },
  { format: 'html', path: 'C:\\invento' },
])('rechaza argumentos inválidos %j', async (input) => {
  await expect(
    handler(event, { reportDraftId: id, ...input }),
  ).rejects.toThrow();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
});
it('rechaza otra ventana, subframe, navegación y argumentos adicionales', async () => {
  for (const input of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { url } },
  ])
    await expect(
      handler(input as unknown as IpcMainInvokeEvent, {
        reportDraftId: id,
        format: 'html',
      }),
    ).rejects.toThrow();
  await expect(
    handler(event, { reportDraftId: id, format: 'html' }, 'extra'),
  ).rejects.toThrow();
  frame.url = 'https://example.invalid';
  await expect(
    handler(event, { reportDraftId: id, format: 'html' }),
  ).rejects.toThrow();
  expect(mocks.save).not.toHaveBeenCalled();
});
it.each(['navigation', 'stop'])(
  'no escribe si ocurre %s durante el diálogo',
  async (mode) => {
    mocks.save.mockImplementationOnce(async () => {
      if (mode === 'stop') stop();
      else frame.url = 'https://example.invalid';
      return { canceled: false, filePath: join(root, 'out.html') };
    });
    await expect(
      handler(event, { reportDraftId: id, format: 'html' }),
    ).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled();
  },
);
it('no expone errores de escritura y retira el handler al cerrar', async () => {
  mocks.write.mockRejectedValueOnce(new Error('PRIVATE-PATH-ERROR'));
  await expect(
    handler(event, { reportDraftId: id, format: 'json' }),
  ).rejects.toThrow(/^No se pudo exportar el reporte\./);
  stop();
  expect(mocks.removeHandler).toHaveBeenCalledWith('reports:export');
  await expect(
    handler(event, { reportDraftId: id, format: 'json' }),
  ).rejects.toThrow();
});

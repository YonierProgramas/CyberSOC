import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  registerAssistantIpc,
  type AssistantService,
} from '../src/main/ipc/assistant.ipc';
import {
  ASSISTANT_ASK,
  ASSISTANT_RESET,
  type AssistantReplyDTO,
} from '../src/shared/ipc';

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
const reply: AssistantReplyDTO = {
  status: 'ANSWERED',
  text: 'Fue marcado por ev1 (SIGNATURES).',
  errorKind: null,
  focus: { kind: 'RESULT', id: 'r1', label: 'factura.pdf.exe' },
  historyTurns: 1,
};
let service: AssistantService;
let stop: () => void;

function call(
  channel: string,
  sender = event,
  ...args: unknown[]
): Promise<unknown> {
  return Promise.resolve(
    electron.handle.mock.calls.find(([name]) => name === channel)![1](
      sender,
      ...args,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  frame.url = url;
  service = {
    ask: vi.fn(async () => reply),
    reset: vi.fn(),
  };
  stop = registerAssistantIpc(() => window, url, service);
});

it('registra assistant:ask y assistant:reset', () => {
  expect(electron.handle.mock.calls.map(([name]) => name)).toEqual([
    ASSISTANT_ASK,
    ASSISTANT_RESET,
  ]);
});

it('ask valida la pregunta y el foco y devuelve la respuesta', async () => {
  for (const query of [
    { message: '¿Por qué fue marcado?', focus: { resultId: 'r1' } },
    { message: 'Resúmeme el escaneo', focus: { jobId: 'j1' } },
    { message: 'hola' },
    { message: 'x'.repeat(2_000) },
  ]) {
    await expect(call(ASSISTANT_ASK, event, query)).resolves.toEqual(reply);
    expect(service.ask).toHaveBeenLastCalledWith(query);
  }
});

it.each([
  ['mensaje de 2 001 caracteres', { message: 'x'.repeat(2_001) }],
  ['mensaje vacío', { message: '' }],
  ['mensaje solo con espacios', { message: '   \n ' }],
  ['mensaje que no es texto', { message: 42 }],
  ['sin mensaje', {}],
  ['campo extra', { message: 'hola', role: 'system' }],
  [
    'resultado y escaneo a la vez',
    { message: 'hola', focus: { resultId: 'r1', jobId: 'j1' } },
  ],
  ['foco con campo extra', { message: 'hola', focus: { path: 'C:\\x' } }],
  ['id vacío', { message: 'hola', focus: { resultId: '' } }],
  [
    'id demasiado largo',
    { message: 'hola', focus: { resultId: 'r'.repeat(65) } },
  ],
  ['no es objeto', 'hola'],
])('ask rechaza %s sin llamar al servicio', async (_name, query) => {
  await expect(call(ASSISTANT_ASK, event, query)).rejects.toThrow(
    'No se pudo completar la consulta al asistente.',
  );
  expect(service.ask).not.toHaveBeenCalled();
});

it('ask rechaza argumentos de más', async () => {
  await expect(
    call(ASSISTANT_ASK, event, { message: 'hola' }, 'extra'),
  ).rejects.toThrow();
  expect(service.ask).not.toHaveBeenCalled();
});

it('rechaza otra ventana, un subframe o una navegación', async () => {
  for (const sender of [
    { sender: {}, senderFrame: frame },
    { sender: webContents, senderFrame: { url } },
  ])
    await expect(
      call(ASSISTANT_ASK, sender as unknown as IpcMainInvokeEvent, {
        message: 'hola',
      }),
    ).rejects.toThrow();
  frame.url = 'https://ataque.example/';
  await expect(
    call(ASSISTANT_ASK, event, { message: 'hola' }),
  ).rejects.toThrow();
  await expect(call(ASSISTANT_RESET)).rejects.toThrow();
  expect(service.ask).not.toHaveBeenCalled();
  expect(service.reset).not.toHaveBeenCalled();
});

it('no propaga el error original del servicio', async () => {
  service.ask = vi.fn(async () => {
    throw new Error('C:\\Users\\privado\\secreto.exe no existe');
  });
  stop();
  stop = registerAssistantIpc(() => window, url, service);
  const error = await call(ASSISTANT_ASK, event, {
    message: 'hola',
    focus: { resultId: 'no-existe' },
  }).catch((e: unknown) => e as Error);
  expect((error as Error).message).toBe(
    'No se pudo completar la consulta al asistente.',
  );
});

it('valida también la respuesta: campos de más no llegan al renderer', async () => {
  service.ask = vi.fn(async () => ({ ...reply, rawPrompt: 'interno' }));
  stop();
  stop = registerAssistantIpc(() => window, url, service);
  await expect(
    call(ASSISTANT_ASK, event, { message: 'hola' }),
  ).rejects.toThrow();
});

it('reset no admite argumentos y llama al servicio', async () => {
  await expect(call(ASSISTANT_RESET)).resolves.toBeUndefined();
  expect(service.reset).toHaveBeenCalledTimes(1);
  await expect(call(ASSISTANT_RESET, event, 'extra')).rejects.toThrow(
    'No se pudo reiniciar la conversación.',
  );
  expect(service.reset).toHaveBeenCalledTimes(1);
});

it('al detenerse quita los handlers y rechaza llamadas pendientes', async () => {
  const handlers = electron.handle.mock.calls.map(([, handler]) => handler);
  stop();
  expect(electron.removeHandler).toHaveBeenCalledWith(ASSISTANT_ASK);
  expect(electron.removeHandler).toHaveBeenCalledWith(ASSISTANT_RESET);
  await expect(
    Promise.resolve(handlers[0]!(event, { message: 'hola' })),
  ).rejects.toThrow();
});

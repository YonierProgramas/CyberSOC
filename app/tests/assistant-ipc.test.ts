import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  registerAssistantIpc,
  type AssistantService,
} from '../src/main/ipc/assistant.ipc';
import {
  ASSISTANT_ASK,
  ASSISTANT_RESET,
  ASSISTANT_LIST_CONVERSATIONS,
  ASSISTANT_OPEN_CONVERSATION,
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
const conversation = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Conversación guardada',
  createdAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
};

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
    listConversations: vi.fn(() => []),
    openConversation: vi.fn(() => ({
      conversation,
      messages: [],
      historyTurns: 0,
    })),
  };
  stop = registerAssistantIpc(() => window, url, service);
});

it('registra las cuatro operaciones del asistente', () => {
  expect(electron.handle.mock.calls.map(([name]) => name)).toEqual([
    ASSISTANT_ASK,
    ASSISTANT_RESET,
    ASSISTANT_LIST_CONVERSATIONS,
    ASSISTANT_OPEN_CONVERSATION,
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
  expect(electron.removeHandler).toHaveBeenCalledWith(
    ASSISTANT_LIST_CONVERSATIONS,
  );
  expect(electron.removeHandler).toHaveBeenCalledWith(
    ASSISTANT_OPEN_CONVERSATION,
  );
  await expect(
    Promise.resolve(handlers[0]!(event, { message: 'hola' })),
  ).rejects.toThrow();
});

it('lista con paginación y abre por UUID', async () => {
  service.listConversations = vi.fn(() => [conversation]);
  await expect(call(ASSISTANT_LIST_CONVERSATIONS)).resolves.toEqual([
    conversation,
  ]);
  await call(ASSISTANT_LIST_CONVERSATIONS, event, { limit: 10, offset: 20 });
  expect(service.listConversations).toHaveBeenLastCalledWith({
    limit: 10,
    offset: 20,
  });
  await expect(
    call(ASSISTANT_OPEN_CONVERSATION, event, conversation.id),
  ).resolves.toEqual({
    conversation,
    messages: [],
    historyTurns: 0,
  });
  expect(service.openConversation).toHaveBeenCalledExactlyOnceWith(
    conversation.id,
  );
});

it.each([
  [{ limit: 0 }],
  [{ limit: 101 }],
  [{ offset: -1 }],
  [{ offset: 1.5 }],
  [{ limit: '10' }],
  [{ extra: true }],
  [null],
  [{}, 'extra'],
])('rechaza argumentos de listado inválidos: %j', async (...args) => {
  await expect(
    call(ASSISTANT_LIST_CONVERSATIONS, event, ...args),
  ).rejects.toThrow('No se pudieron listar');
  expect(service.listConversations).not.toHaveBeenCalled();
});

it.each([[], [''], ['no-existe'], [42], [conversation.id, 'extra']])(
  'rechaza argumentos de apertura inválidos: %j',
  async (...args) => {
    await expect(
      call(ASSISTANT_OPEN_CONVERSATION, event, ...args),
    ).rejects.toThrow('No se pudo abrir');
    expect(service.openConversation).not.toHaveBeenCalled();
  },
);

it('los nuevos handlers verifican origen, ventana, subframe y cierre', async () => {
  for (const sender of [
    { sender: {}, senderFrame: frame },
    { sender: webContents, senderFrame: { url } },
  ]) {
    await expect(
      call(
        ASSISTANT_LIST_CONVERSATIONS,
        sender as unknown as IpcMainInvokeEvent,
      ),
    ).rejects.toThrow();
    await expect(
      call(
        ASSISTANT_OPEN_CONVERSATION,
        sender as unknown as IpcMainInvokeEvent,
        conversation.id,
      ),
    ).rejects.toThrow();
  }
  frame.url = 'https://example.invalid';
  await expect(call(ASSISTANT_LIST_CONVERSATIONS)).rejects.toThrow();
  await expect(
    call(ASSISTANT_OPEN_CONVERSATION, event, conversation.id),
  ).rejects.toThrow();
  frame.url = url;
  stop();
  await expect(call(ASSISTANT_LIST_CONVERSATIONS)).rejects.toThrow();
  await expect(
    call(ASSISTANT_OPEN_CONVERSATION, event, conversation.id),
  ).rejects.toThrow();
  expect(service.listConversations).not.toHaveBeenCalled();
  expect(service.openConversation).not.toHaveBeenCalled();
});

it('no filtra errores internos ni campos adicionales del historial', async () => {
  service.openConversation = vi.fn(() => {
    throw new Error('ruta-privada');
  });
  await expect(
    call(ASSISTANT_OPEN_CONVERSATION, event, conversation.id),
  ).rejects.toThrow(/^No se pudo abrir la conversación\.$/);
  service.listConversations = vi.fn(() => [
    { ...conversation, secret: 'no-exponer' },
  ]);
  await expect(call(ASSISTANT_LIST_CONVERSATIONS)).rejects.toThrow();
  service.openConversation = vi.fn(() => ({
    conversation,
    messages: [],
    historyTurns: 11,
  }));
  await expect(
    call(ASSISTANT_OPEN_CONVERSATION, event, conversation.id),
  ).rejects.toThrow();
});

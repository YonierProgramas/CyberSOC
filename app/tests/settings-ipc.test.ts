import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  registerSettingsIpc,
  type AISettingsService,
} from '../src/main/ipc/settings.ipc';
import {
  SETTINGS_AI_SET_API_KEY,
  SETTINGS_AI_CLEAR_API_KEY,
  SETTINGS_AI_GET_STATUS,
  SETTINGS_AI_TEST_CONNECTION,
} from '../src/shared/ipc';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: electron, safeStorage: {} }));
const key = 'unit-test-private-key-1234';
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
const status = { configured: true, last4: '1234', model: 'claude-test' };
let service: AISettingsService;
let stop: () => void;
function call(
  channel: string,
  sender = event,
  ...args: unknown[]
): Promise<unknown> {
  return electron.handle.mock.calls.find(([name]) => name === channel)![1](
    sender,
    ...args,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  frame.url = url;
  service = {
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    getStatus: vi.fn(() => status),
    testConnection: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'OFFLINE' as const,
        retryable: true,
        message: 'Sin conexión',
      },
    })),
  };
  stop = registerSettingsIpc(() => window, url, service);
});

it('expone cuatro canales validados; set/clear no devuelven nada y getStatus solo metadatos', async () => {
  expect(electron.handle).toHaveBeenCalledTimes(4);
  await expect(
    call(SETTINGS_AI_SET_API_KEY, event, key),
  ).resolves.toBeUndefined();
  expect(service.setApiKey).toHaveBeenCalledExactlyOnceWith(key);
  await expect(call(SETTINGS_AI_CLEAR_API_KEY)).resolves.toBeUndefined();
  const reply = await call(SETTINGS_AI_GET_STATUS);
  expect(reply).toEqual(status);
  expect(JSON.stringify(reply)).not.toContain(key);
  await expect(call(SETTINGS_AI_TEST_CONNECTION)).resolves.toMatchObject({
    ok: false,
  });
});

it.each([
  SETTINGS_AI_SET_API_KEY,
  SETTINGS_AI_CLEAR_API_KEY,
  SETTINGS_AI_GET_STATUS,
  SETTINGS_AI_TEST_CONNECTION,
])(
  'rechaza otra ventana, subframe, navegación y ausencia de ventana en %s',
  async (channel) => {
    for (const sender of [
      { sender: {}, senderFrame: frame },
      { sender: webContents, senderFrame: { url } },
    ])
      await expect(
        call(
          channel,
          sender as unknown as IpcMainInvokeEvent,
          ...(channel === SETTINGS_AI_SET_API_KEY ? [key] : []),
        ),
      ).rejects.toThrow('configuración');
    frame.url = 'https://untrusted.example';
    await expect(
      call(
        channel,
        event,
        ...(channel === SETTINGS_AI_SET_API_KEY ? [key] : []),
      ),
    ).rejects.toThrow('configuración');
    expect(service.setApiKey).not.toHaveBeenCalled();
    expect(service.clearApiKey).not.toHaveBeenCalled();
    expect(service.getStatus).not.toHaveBeenCalled();
    expect(service.testConnection).not.toHaveBeenCalled();
  },
);

it.each([
  [SETTINGS_AI_SET_API_KEY, []],
  [SETTINGS_AI_SET_API_KEY, [key, 'extra']],
  [SETTINGS_AI_SET_API_KEY, [{ key }]],
  [SETTINGS_AI_SET_API_KEY, ['bad\nkey']],
  [SETTINGS_AI_CLEAR_API_KEY, [key]],
  [SETTINGS_AI_GET_STATUS, [key]],
  [SETTINGS_AI_TEST_CONNECTION, [key]],
] as const)(
  'rechaza argumentos de %s sin incluirlos en el error',
  async (channel, args) => {
    let failure: unknown;
    try {
      await call(channel, event, ...args);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(key);
    expect(service.setApiKey).not.toHaveBeenCalled();
    expect(service.clearApiKey).not.toHaveBeenCalled();
    expect(service.getStatus).not.toHaveBeenCalled();
    expect(service.testConnection).not.toHaveBeenCalled();
  },
);

it('rechaza salidas con campos secretos extra sin propagar ZodError', async () => {
  vi.mocked(service.getStatus).mockReturnValue({
    ...status,
    apiKey: key,
  } as never);
  const error = await call(SETTINGS_AI_GET_STATUS).catch((e: unknown) => e);
  expect(String(error)).toBe(
    'Error: No se pudo completar la operación de configuración de IA.',
  );
  expect(JSON.stringify(error)).not.toContain(key);
});

it('sustituye excepciones de servicio que contienen secretos', async () => {
  vi.mocked(service.setApiKey).mockImplementation(() => {
    throw new Error(key);
  });
  vi.mocked(service.testConnection).mockRejectedValue(new Error(key));
  await expect(call(SETTINGS_AI_SET_API_KEY, event, key)).rejects.toThrow(
    'configuración de IA',
  );
  await expect(call(SETTINGS_AI_TEST_CONNECTION)).rejects.not.toThrow(key);
});

it.each(['navigate', 'close'])(
  'no entrega una respuesta pendiente después de %s',
  async (action) => {
    let finish!: () => void;
    vi.mocked(service.testConnection).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: false,
              error: {
                kind: 'OFFLINE',
                retryable: true,
                message: 'Sin conexión',
              },
            });
        }),
    );
    const request = call(SETTINGS_AI_TEST_CONNECTION);
    if (action === 'navigate') frame.url = 'about:blank';
    else stop();
    finish();
    await expect(request).rejects.toThrow('configuración de IA');
  },
);

it('retira los handlers e invalida referencias conservadas al cerrar', async () => {
  stop();
  expect(electron.removeHandler).toHaveBeenCalledTimes(4);
  await expect(call(SETTINGS_AI_GET_STATUS)).rejects.toThrow('configuración');
  expect(service.getStatus).not.toHaveBeenCalled();
});

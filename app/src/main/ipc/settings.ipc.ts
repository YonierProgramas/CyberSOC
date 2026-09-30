import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  SETTINGS_AI_SET_API_KEY,
  SETTINGS_AI_CLEAR_API_KEY,
  SETTINGS_AI_GET_STATUS,
  SETTINGS_AI_TEST_CONNECTION,
  type AISettingsStatus,
  type AIHealthCheck,
} from '../../shared/ipc';
import { apiKeySchema } from '../SecretStore';
import { requireTrustedSender } from './scan-validation';

export interface AISettingsService {
  setApiKey(key: string): void;
  clearApiKey(): void;
  getStatus(): AISettingsStatus;
  testConnection(): Promise<AIHealthCheck>;
}

const noArguments = z.tuple([]);
const setArguments = z.tuple([apiKeySchema]);
const statusSchema = z
  .strictObject({
    configured: z.boolean(),
    last4: z.string().length(4).nullable(),
    model: z.string().min(1),
  })
  .refine((value) => value.configured === (value.last4 !== null));
const healthSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    value: z.strictObject({ model: z.string().min(1) }),
    model: z.string().min(1),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
    latencyMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      kind: z.enum([
        'OFFLINE',
        'TIMEOUT',
        'RATE_LIMIT',
        'AUTH',
        'PROVIDER_DOWN',
        'INVALID_OUTPUT',
        'INCOMPLETE',
        'UNSAFE',
      ]),
      retryable: z.boolean(),
      retryAfterMs: z.number().nonnegative().optional(),
      message: z.string(),
    }),
  }),
]);

export function registerSettingsIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  service: AISettingsService,
): () => void {
  let active = true;
  function validate(event: IpcMainInvokeEvent): void {
    if (!active) throw new Error();
    requireTrustedSender(getWindow, trustedRendererUrl, event);
  }
  const channels = [
    SETTINGS_AI_SET_API_KEY,
    SETTINGS_AI_CLEAR_API_KEY,
    SETTINGS_AI_GET_STATUS,
    SETTINGS_AI_TEST_CONNECTION,
  ] as const;
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        validate(event);
        if (channel === SETTINGS_AI_SET_API_KEY) {
          const [key] = setArguments.parse(args);
          service.setApiKey(key);
          return;
        }
        noArguments.parse(args);
        if (channel === SETTINGS_AI_CLEAR_API_KEY) {
          service.clearApiKey();
          return;
        }
        if (channel === SETTINGS_AI_GET_STATUS)
          return statusSchema.parse(service.getStatus());
        const result = await service.testConnection();
        validate(event); // La ventana puede haberse cerrado o navegado durante la petición.
        return healthSchema.parse(result);
      } catch {
        // Electron puede registrar errores de handlers: nunca propagar el error original,
        // los argumentos, un ZodError o un cuerpo HTTP que pueda incluir la clave.
        throw new Error(
          'No se pudo completar la operación de configuración de IA.',
        );
      }
    });
  }
  return () => {
    active = false;
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

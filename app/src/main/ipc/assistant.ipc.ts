import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  ASSISTANT_ASK,
  ASSISTANT_MESSAGE_MAX_CHARS,
  ASSISTANT_RESET,
  type AssistantAskQuery,
  type AssistantReplyDTO,
} from '../../shared/ipc';
import { noArguments, requireTrustedSender } from './scan-validation';

export interface AssistantService {
  ask(query: AssistantAskQuery): Promise<AssistantReplyDTO>;
  reset(): void;
}

const idSchema = z.string().min(1).max(64);
export const assistantAskSchema = z.strictObject({
  message: z
    .string()
    .max(ASSISTANT_MESSAGE_MAX_CHARS)
    .refine((message) => message.trim() !== '', 'La pregunta está vacía.'),
  focus: z
    .strictObject({
      resultId: idSchema.optional(),
      jobId: idSchema.optional(),
    })
    .refine(
      (focus) => focus.resultId === undefined || focus.jobId === undefined,
      'El foco es un resultado o un escaneo, no ambos.',
    )
    .optional(),
});
const askArguments = z.tuple([assistantAskSchema]);

const errorKindSchema = z.enum([
  'NOT_CONFIGURED',
  'OFFLINE',
  'TIMEOUT',
  'RATE_LIMIT',
  'AUTH',
  'PROVIDER_DOWN',
  'INVALID_OUTPUT',
  'INCOMPLETE',
  'UNSAFE',
]);
/** La respuesta también se valida: al renderer solo llegan estos campos. */
const replySchema = z.strictObject({
  status: z.enum(['ANSWERED', 'UNAVAILABLE', 'CANCELLED']),
  text: z.string(),
  errorKind: errorKindSchema.nullable(),
  focus: z.strictObject({
    kind: z.enum(['NONE', 'RESULT', 'JOB']),
    id: z.string().nullable(),
    label: z.string().nullable(),
  }),
  historyTurns: z.number().int().min(0).max(10),
});

export function registerAssistantIpc(
  getWindow: () => BrowserWindow | null,
  trustedRendererUrl: string,
  service: AssistantService,
): () => void {
  let active = true;
  function validate(event: IpcMainInvokeEvent): void {
    if (!active) throw new Error();
    requireTrustedSender(getWindow, trustedRendererUrl, event);
  }

  ipcMain.handle(ASSISTANT_ASK, async (event, ...args: unknown[]) => {
    try {
      validate(event);
      const [query] = askArguments.parse(args);
      const reply = await service.ask(query);
      validate(event); // La ventana puede haberse cerrado o navegado durante la petición.
      return replySchema.parse(reply);
    } catch {
      // Nunca propagar el error original: puede contener la pregunta, rutas o un ZodError.
      throw new Error('No se pudo completar la consulta al asistente.');
    }
  });
  ipcMain.handle(ASSISTANT_RESET, async (event, ...args: unknown[]) => {
    try {
      validate(event);
      noArguments.parse(args);
      service.reset();
    } catch {
      throw new Error('No se pudo reiniciar la conversación.');
    }
  });

  return () => {
    active = false;
    ipcMain.removeHandler(ASSISTANT_ASK);
    ipcMain.removeHandler(ASSISTANT_RESET);
  };
}

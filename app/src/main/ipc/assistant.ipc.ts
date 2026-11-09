import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  ASSISTANT_ASK,
  ASSISTANT_MESSAGE_MAX_CHARS,
  ASSISTANT_RESET,
  ASSISTANT_LIST_CONVERSATIONS,
  ASSISTANT_OPEN_CONVERSATION,
  type AssistantAskQuery,
  type AssistantReplyDTO,
  type ConversationDTO,
  type ConversationQuery,
  type OpenConversationDTO,
} from '../../shared/ipc';
import {
  assistantReferenceSchema,
  assistantActionSchema,
  reportCardSchema,
  scanPlanCardSchema,
} from '../../shared/assistant-card-schemas';
import { noArguments, requireTrustedSender } from './scan-validation';

export interface AssistantService {
  ask(query: AssistantAskQuery): Promise<AssistantReplyDTO>;
  reset(): void;
  listConversations(query?: ConversationQuery): ConversationDTO[];
  openConversation(id: string): OpenConversationDTO;
}

export const conversationQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
const listArguments = z.union([
  z.tuple([]),
  z.tuple([conversationQuerySchema]),
]);
const conversationIdSchema = z.string().uuid();
const openArguments = z.tuple([conversationIdSchema]);
const conversationSchema = z.strictObject({
  id: conversationIdSchema,
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const openConversationSchema = z
  .strictObject({
    conversation: conversationSchema,
    messages: z.array(
      z.strictObject({
        id: z.string().uuid(),
        conversationId: conversationIdSchema,
        role: z.enum(['user', 'assistant', 'tool']),
        content: z.string(),
        toolCallsJson: z
          .string()
          .refine((value) => {
            try {
              JSON.parse(value);
              return true;
            } catch {
              return false;
            }
          })
          .nullable(),
        model: z.string().nullable(),
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
    historyTurns: z.number().int().min(0).max(10),
  })
  .refine((value) =>
    value.messages.every(
      (message) => message.conversationId === value.conversation.id,
    ),
  );

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
  'TOOL_LIMIT',
]);
/** The response is validated too: only these fields reach the renderer. */
export const assistantReplySchema = z.strictObject({
  status: z.enum(['ANSWERED', 'UNAVAILABLE', 'CANCELLED']),
  text: z.string(),
  errorKind: errorKindSchema.nullable(),
  focus: z.strictObject({
    kind: z.enum(['NONE', 'RESULT', 'JOB']),
    id: z.string().nullable(),
    label: z.string().nullable(),
  }),
  historyTurns: z.number().int().min(0).max(10),
  references: z.array(assistantReferenceSchema).max(20),
  suggestedActions: z.array(assistantActionSchema).max(6),
  report: reportCardSchema.nullable(),
  scanPlan: scanPlanCardSchema.nullable(),
  toolCalls: z
    .array(
      z.strictObject({
        name: z.string().max(64),
        ok: z.boolean(),
        code: z.string().max(32).nullable(),
      }),
    )
    .max(60),
  rejected: z.array(z.string().max(300)).max(40),
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
      validate(event); // The window may have closed or navigated during the request.
      return assistantReplySchema.parse(reply);
    } catch {
      // Never propagate the original error: it may contain the question, paths or a ZodError.
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
  ipcMain.handle(
    ASSISTANT_LIST_CONVERSATIONS,
    async (event, ...args: unknown[]) => {
      try {
        validate(event);
        const [query] = listArguments.parse(args);
        return z
          .array(conversationSchema)
          .max(100)
          .parse(service.listConversations(query));
      } catch {
        throw new Error('No se pudieron listar las conversaciones.');
      }
    },
  );
  ipcMain.handle(
    ASSISTANT_OPEN_CONVERSATION,
    async (event, ...args: unknown[]) => {
      try {
        validate(event);
        const [id] = openArguments.parse(args);
        return openConversationSchema.parse(service.openConversation(id));
      } catch {
        throw new Error('No se pudo abrir la conversación.');
      }
    },
  );

  return () => {
    active = false;
    ipcMain.removeHandler(ASSISTANT_ASK);
    ipcMain.removeHandler(ASSISTANT_RESET);
    ipcMain.removeHandler(ASSISTANT_LIST_CONVERSATIONS);
    ipcMain.removeHandler(ASSISTANT_OPEN_CONVERSATION);
  };
}

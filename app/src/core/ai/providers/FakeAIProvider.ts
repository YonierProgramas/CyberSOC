import type {
  AIError,
  AIErrorKind,
  AIProvider,
  AIResult,
  AIUsage,
  AssistantTurnRequest,
  StructuredRequest,
} from '../AIProvider';

/** Reintentabilidad por defecto de cada tipo de error (tabla de fallos de S2). */
const DEFAULT_RETRYABLE: Record<AIErrorKind, boolean> = {
  OFFLINE: true,
  TIMEOUT: true,
  RATE_LIMIT: true,
  AUTH: false,
  PROVIDER_DOWN: true,
  INVALID_OUTPUT: true,
  INCOMPLETE: true,
  UNSAFE: false,
};

const DEFAULT_RETRY_AFTER_MS = 1_000;

interface ValueOptions {
  model?: string;
  usage?: AIUsage;
  latencyMs?: number;
}

interface ErrorOptions {
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

interface RawOptions extends ValueOptions {
  /** `'max_tokens'` simula una respuesta cortada (INCOMPLETE). Por defecto `'end_turn'`. */
  stopReason?: 'end_turn' | 'max_tokens';
}

type Scripted =
  | { kind: 'value'; value: unknown; options: ValueOptions }
  | { kind: 'raw'; text: string; options: RawOptions }
  | { kind: 'error'; error: AIError };

type ScriptedReply =
  | { kind: 'reply'; text: string; options: ValueOptions }
  | { kind: 'error'; error: AIError };

export interface FakeAIProviderOptions {
  model?: string;
}

/**
 * Proveedor de IA programable para pruebas: nunca usa la red.
 * Cada llamada a `generateStructured` consume la siguiente respuesta de la cola (FIFO).
 * `runAssistantTurn` tiene su propia cola, para que el chat no consuma respuestas del análisis.
 */
export class FakeAIProvider implements AIProvider {
  readonly id = 'fake';
  readonly model: string;
  /** Peticiones recibidas, en orden, para inspeccionarlas desde las pruebas. */
  readonly requests: StructuredRequest<unknown>[] = [];
  /** Turnos del asistente recibidos, en orden. */
  readonly assistantRequests: AssistantTurnRequest[] = [];
  private readonly script: Scripted[] = [];
  private readonly replies: ScriptedReply[] = [];
  private healthError: AIError | null = null;

  constructor(options: FakeAIProviderOptions = {}) {
    this.model = options.model ?? 'fake-model';
  }

  /** Programa una respuesta válida. Se valida contra el esquema de la petición al consumirse. */
  enqueueValue(value: unknown, options: ValueOptions = {}): this {
    this.script.push({ kind: 'value', value, options });
    return this;
  }

  /**
   * Programa el texto exacto que devolvería el modelo (p. ej. JSON roto o cortado). Se procesa
   * igual que en ClaudeProvider: INCOMPLETE si se cortó, INVALID_OUTPUT si no es JSON o no cumple
   * el esquema; en ambos casos el error lleva `rawText` y `usage`.
   */
  enqueueRaw(text: string, options: RawOptions = {}): this {
    this.script.push({ kind: 'raw', text, options });
    return this;
  }

  /** Programa un error simulado. `retryable` toma el valor por defecto del tipo si no se indica. */
  enqueueError(kind: AIErrorKind, options: ErrorOptions = {}): this {
    this.script.push({ kind: 'error', error: simulatedError(kind, options) });
    return this;
  }

  /** Programa la respuesta de texto del siguiente turno del asistente. */
  enqueueReply(text: string, options: ValueOptions = {}): this {
    this.replies.push({ kind: 'reply', text, options });
    return this;
  }

  /** Programa un error para el siguiente turno del asistente. */
  enqueueReplyError(kind: AIErrorKind, options: ErrorOptions = {}): this {
    this.replies.push({ kind: 'error', error: simulatedError(kind, options) });
    return this;
  }

  /** Hace que `healthCheck` falle con el error indicado (o vuelva a responder bien con `null`). */
  setHealthError(kind: AIErrorKind | null, options: ErrorOptions = {}): this {
    this.healthError =
      kind === null
        ? null
        : {
            kind,
            retryable: options.retryable ?? DEFAULT_RETRYABLE[kind],
            message: options.message ?? `Error simulado: ${kind}.`,
            ...(options.retryAfterMs !== undefined
              ? { retryAfterMs: options.retryAfterMs }
              : {}),
          };
    return this;
  }

  /** Respuestas programadas que aún no se han consumido. */
  get pending(): number {
    return this.script.length;
  }

  async healthCheck(): Promise<AIResult<{ model: string }>> {
    if (this.healthError) return { ok: false, error: { ...this.healthError } };
    return {
      ok: true,
      value: { model: this.model },
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>> {
    this.requests.push(req);
    if (req.signal?.aborted) {
      return {
        ok: false,
        error: {
          kind: 'TIMEOUT',
          retryable: false,
          message: 'Solicitud cancelada.',
        },
      };
    }
    const next = this.script.shift();
    if (!next) {
      throw new Error(
        'FakeAIProvider: no hay respuestas programadas para esta llamada.',
      );
    }
    if (next.kind === 'error') return { ok: false, error: { ...next.error } };

    const rawText =
      next.kind === 'raw' ? next.text : JSON.stringify(next.value);
    const usage = {
      ...(next.options.usage ?? { inputTokens: 0, outputTokens: 0 }),
    };
    const failure = (
      kind: AIErrorKind,
      message: string,
    ): { ok: false; error: AIError } => ({
      ok: false,
      error: {
        kind,
        retryable: true,
        message,
        rawText,
        usage,
        model: next.options.model ?? this.model,
        latencyMs: next.options.latencyMs ?? 0,
      },
    });

    if (next.kind === 'raw' && next.options.stopReason === 'max_tokens') {
      return failure(
        'INCOMPLETE',
        'Respuesta cortada por el límite de tokens.',
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return failure('INVALID_OUTPUT', 'La respuesta no es JSON válido.');
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      return failure('INVALID_OUTPUT', 'La respuesta no cumple el esquema.');
    }
    return {
      ok: true,
      value: parsed.data,
      model: next.options.model ?? this.model,
      usage,
      latencyMs: next.options.latencyMs ?? 0,
      rawText,
    };
  }

  async runAssistantTurn(req: AssistantTurnRequest): Promise<AIResult<string>> {
    this.assistantRequests.push(req);
    if (req.signal?.aborted) {
      return {
        ok: false,
        error: {
          kind: 'TIMEOUT',
          retryable: false,
          message: 'Solicitud cancelada.',
        },
      };
    }
    const next = this.replies.shift();
    if (!next) {
      throw new Error(
        'FakeAIProvider: no hay respuestas del asistente programadas.',
      );
    }
    if (next.kind === 'error') return { ok: false, error: { ...next.error } };
    return {
      ok: true,
      value: next.text,
      model: next.options.model ?? req.model ?? this.model,
      usage: { ...(next.options.usage ?? { inputTokens: 0, outputTokens: 0 }) },
      latencyMs: next.options.latencyMs ?? 0,
      rawText: next.text,
    };
  }
}

function simulatedError(kind: AIErrorKind, options: ErrorOptions): AIError {
  const error: AIError = {
    kind,
    retryable: options.retryable ?? DEFAULT_RETRYABLE[kind],
    message: options.message ?? `Error simulado: ${kind}.`,
  };
  if (kind === 'RATE_LIMIT' || options.retryAfterMs !== undefined) {
    error.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  }
  return error;
}

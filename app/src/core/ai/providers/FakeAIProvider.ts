import type {
  AIError,
  AIErrorKind,
  AIProvider,
  AIResult,
  AIUsage,
  AssistantStep,
  AssistantTurnRequest,
  StructuredRequest,
} from '../AIProvider';

/** Default retryability of each error kind (S2 failure table). */
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
  /** `'max_tokens'` simulates a cut-off response (INCOMPLETE). Defaults to `'end_turn'`. */
  stopReason?: 'end_turn' | 'max_tokens';
}

type Scripted =
  | { kind: 'value'; value: unknown; options: ValueOptions }
  | { kind: 'raw'; text: string; options: RawOptions }
  | { kind: 'error'; error: AIError };

type ScriptedReply =
  | { kind: 'reply'; text: string; options: ValueOptions }
  | { kind: 'final'; value: unknown; options: ValueOptions }
  | {
      kind: 'tools';
      calls: readonly { name: string; input: unknown; id?: string }[];
      options: ValueOptions;
    }
  | { kind: 'error'; error: AIError };

export interface FakeAIProviderOptions {
  model?: string;
}

/**
 * Programmable AI provider for tests: it never uses the network.
 * Each call to `generateStructured` consumes the next response from the queue (FIFO).
 * `runAssistantTurn` has its own queue, so the chat does not consume analysis responses.
 */
export class FakeAIProvider implements AIProvider {
  readonly id = 'fake';
  readonly model: string;
  /** Requests received, in order, so tests can inspect them. */
  readonly requests: StructuredRequest<unknown>[] = [];
  /** Assistant turns received, in order. */
  readonly assistantRequests: AssistantTurnRequest<unknown>[] = [];
  private toolCallSeq = 0;
  private readonly script: Scripted[] = [];
  private readonly replies: ScriptedReply[] = [];
  private healthError: AIError | null = null;

  constructor(options: FakeAIProviderOptions = {}) {
    this.model = options.model ?? 'fake-model';
  }

  /** Programs a valid response. It is validated against the request schema when consumed. */
  enqueueValue(value: unknown, options: ValueOptions = {}): this {
    this.script.push({ kind: 'value', value, options });
    return this;
  }

  /**
   * Programs the exact text the model would return (e.g. broken or cut-off JSON). It is processed
   * as in ClaudeProvider: INCOMPLETE if cut off, INVALID_OUTPUT if it is not JSON or fails
   * the schema; in both cases the error carries `rawText` and `usage`.
   */
  enqueueRaw(text: string, options: RawOptions = {}): this {
    this.script.push({ kind: 'raw', text, options });
    return this;
  }

  /** Programs a simulated error. `retryable` takes the kind's default value if not given. */
  enqueueError(kind: AIErrorKind, options: ErrorOptions = {}): this {
    this.script.push({ kind: 'error', error: simulatedError(kind, options) });
    return this;
  }

  /** Programs the text response of the next assistant turn. */
  enqueueReply(text: string, options: ValueOptions = {}): this {
    this.replies.push({ kind: 'reply', text, options });
    return this;
  }

  /** Programs the structured final response of Copilot v2 (validated against `output`). */
  enqueueFinal(value: unknown, options: ValueOptions = {}): this {
    this.replies.push({ kind: 'final', value, options });
    return this;
  }

  /** Programs a step in which the model requests one or more tools. */
  enqueueToolCalls(
    calls: readonly { name: string; input: unknown; id?: string }[],
    options: ValueOptions = {},
  ): this {
    this.replies.push({ kind: 'tools', calls, options });
    return this;
  }

  /** Programs an error for the next assistant turn. */
  enqueueReplyError(kind: AIErrorKind, options: ErrorOptions = {}): this {
    this.replies.push({ kind: 'error', error: simulatedError(kind, options) });
    return this;
  }

  /** Makes `healthCheck` fail with the given error (or respond normally again with `null`). */
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

  /** Programmed responses not yet consumed. */
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
      throw new Error('FakeAIProvider: no responses programmed for this call.');
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

  async runAssistantTurn<T = string>(
    req: AssistantTurnRequest<T>,
  ): Promise<AIResult<AssistantStep<T>>> {
    this.assistantRequests.push(req as AssistantTurnRequest<unknown>);
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
      throw new Error('FakeAIProvider: no assistant responses programmed.');
    }
    if (next.kind === 'error') return { ok: false, error: { ...next.error } };
    const meta = {
      model: next.options.model ?? req.model ?? this.model,
      usage: { ...(next.options.usage ?? { inputTokens: 0, outputTokens: 0 }) },
      latencyMs: next.options.latencyMs ?? 0,
    };
    if (next.kind === 'tools') {
      // Same as the API: without declared tools there can be no calls.
      if (!req.tools?.length || req.toolChoice === 'none')
        return {
          ok: false,
          error: {
            kind: 'INVALID_OUTPUT',
            retryable: true,
            message: 'Llamada a herramienta inesperada.',
          },
        };
      const calls = next.calls.map((call, index) => ({
        id: call.id ?? `toolu_fake_${++this.toolCallSeq}_${index}`,
        name: call.name,
        input: call.input,
      }));
      return {
        ok: true,
        value: {
          kind: 'TOOL_CALLS',
          calls,
          content: calls.map((call) => ({ type: 'tool_use', ...call })),
        },
        rawText: '',
        ...meta,
      };
    }
    const text = next.kind === 'final' ? JSON.stringify(next.value) : next.text;
    if (!req.output)
      return {
        ok: true,
        value: { kind: 'FINAL', value: text as T, text },
        rawText: text,
        ...meta,
      };
    // Same processing as ClaudeProvider: JSON and output schema.
    const failure = (message: string): AIResult<AssistantStep<T>> => ({
      ok: false,
      error: {
        kind: 'INVALID_OUTPUT',
        retryable: true,
        message,
        rawText: text,
        ...meta,
      },
    });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return failure('La respuesta no es JSON válido.');
    }
    const parsed = req.output.safeParse(json);
    if (!parsed.success) return failure('La respuesta no cumple el esquema.');
    return {
      ok: true,
      value: { kind: 'FINAL', value: parsed.data, text },
      rawText: text,
      ...meta,
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

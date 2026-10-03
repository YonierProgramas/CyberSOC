import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import { z } from 'zod';
// Solo importaciones de tipos: este archivo también se ejecuta con el type stripping de Node (ai:smoke).
import type {
  AIError,
  AIProvider,
  AIResult,
  AssistantBlock,
  AssistantMessage,
  AssistantStep,
  AssistantToolSpec,
  AssistantTurnRequest,
  StructuredRequest,
} from '../AIProvider';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ClaudeProviderOptions {
  /** API key explícita. El proveedor nunca la lee del entorno. */
  apiKey: string;
  /** Modelo explícito, por ejemplo `claude-haiku-4-5-20251001`. */
  model: string;
  timeoutMs?: number;
  /** Por defecto `https://api.anthropic.com`; se ignora `ANTHROPIC_BASE_URL`. */
  baseURL?: string;
  /** Cliente HTTP alternativo; lo usan las pruebas para no tocar la red. */
  fetch?: ClientOptions['fetch'];
}

/**
 * Proveedor de IA sobre la API de Claude (Messages API + salidas estructuradas).
 * Nunca lanza por fallos del proveedor: los devuelve como `AIResult` con `ok: false`.
 * Los reintentos son responsabilidad del llamador (el SDK se configura con `maxRetries: 0`).
 */
export class ClaudeProvider implements AIProvider {
  readonly id = 'claude';
  readonly model: string;
  readonly timeoutMs: number;
  // Campo privado real para que la clave no aparezca al serializar o inspeccionar el proveedor.
  readonly #client: Anthropic;

  constructor(options: ClaudeProviderOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new TypeError('ClaudeProvider: se requiere una apiKey explícita.');
    }
    if (typeof options.model !== 'string' || options.model.trim() === '') {
      throw new TypeError('ClaudeProvider: se requiere un modelo explícito.');
    }
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Todo explícito: con valores `undefined` el SDK leería ANTHROPIC_API_KEY,
    // ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL y ANTHROPIC_LOG del entorno.
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      authToken: null,
      webhookKey: null,
      baseURL: options.baseURL ?? ANTHROPIC_API_URL,
      maxRetries: 0,
      timeout: this.timeoutMs,
      logLevel: 'off',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async healthCheck(): Promise<AIResult<{ model: string }>> {
    const started = performance.now();
    const signals = this.createSignal();
    try {
      const info = await this.#client.models.retrieve(this.model, null, {
        signal: signals.signal,
      });
      return {
        ok: true,
        value: { model: info.id },
        model: info.id,
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: elapsed(started),
      };
    } catch (error) {
      return { ok: false, error: this.mapError(error, signals) };
    }
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>> {
    const schema = toClaudeJsonSchema(req.schema);
    const started = performance.now();
    const signals = this.createSignal(req.signal);
    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
          output_config: { format: { type: 'json_schema', schema } },
        },
        { signal: signals.signal },
      );
    } catch (error) {
      return { ok: false, error: this.mapError(error, signals) };
    }

    // El texto y los tokens se conservan también en los fallos: la respuesta se guarda para
    // auditoría y AIResponseValidator decide su validation_status exacto.
    const rawText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    const withResponse = (error: AIError): { ok: false; error: AIError } => ({
      ok: false,
      error: {
        ...error,
        rawText,
        usage,
        model: response.model,
        latencyMs: elapsed(started),
      },
    });

    // "max_tokens" se comprueba antes de parsear: una respuesta cortada es INCOMPLETE, no JSON roto.
    const stopError = mapStopReason(response.stop_reason);
    if (stopError) return withResponse(stopError);

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return withResponse(
        invalidOutput('La respuesta no es JSON válido.').error,
      );
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success)
      return withResponse(
        invalidOutput('La respuesta no cumple el esquema.').error,
      );

    return {
      ok: true,
      value: parsed.data,
      model: response.model,
      usage,
      latencyMs: elapsed(started),
      rawText,
    };
  }

  /**
   * Un paso del Copilot. Sin `tools` ni `output` es el turno de texto de S4. Con `tools`
   * (siempre `strict: true`) y `output` (`output_config.format`) es el paso de S5: según la
   * documentación de salidas estructuradas, ambos se combinan en la misma petición; el modelo
   * llama herramientas (stop_reason `tool_use`) o entrega el JSON final (`end_turn`).
   * Los errores se mapean igual que en `generateStructured`.
   */
  async runAssistantTurn<T = string>(
    req: AssistantTurnRequest<T>,
  ): Promise<AIResult<AssistantStep<T>>> {
    if (req.messages.length === 0 || req.messages.at(-1)!.role !== 'user') {
      throw new TypeError(
        'ClaudeProvider: la conversación debe terminar con un mensaje del usuario.',
      );
    }
    // Con tool_choice 'none' las herramientas no pueden llamarse: se declaran sin strict
    // para no sumar su gramática a la de output_config (la API rechaza la combinación de
    // las 14 herramientas estrictas con el esquema de salida: "compiled grammar is too large").
    const declareOnly = req.toolChoice === 'none';
    const tools = req.tools?.map((spec) => toClaudeTool(spec, !declareOnly));
    const started = performance.now();
    const signals = this.createSignal(req.signal);
    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create(
        {
          model: req.model ?? this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          // Copia campo a campo: ningún dato extra del llamador llega a la API.
          messages: req.messages.map(toClaudeMessage),
          ...(tools?.length ? { tools } : {}),
          ...(tools?.length && declareOnly
            ? { tool_choice: { type: 'none' as const } }
            : {}),
          ...(req.output
            ? {
                output_config: {
                  format: {
                    type: 'json_schema' as const,
                    schema: toClaudeJsonSchema(req.output),
                  },
                },
              }
            : {}),
        },
        { signal: signals.signal },
      );
    } catch (error) {
      return { ok: false, error: this.mapError(error, signals) };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
    const meta = {
      model: response.model,
      usage,
      latencyMs: elapsed(started),
    };
    const failure = (error: AIError): { ok: false; error: AIError } => ({
      ok: false,
      error: { ...error, rawText: text, ...meta },
    });

    if (response.stop_reason === 'tool_use') {
      const calls = response.content
        .filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        )
        .map(({ id, name, input }) => ({ id, name, input }));
      if (!tools?.length || calls.length === 0)
        return failure(
          invalidOutput('Llamada a herramienta inesperada.').error,
        );
      const content: AssistantBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'text' && block.text !== '')
          content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use')
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
      }
      return {
        ok: true,
        value: { kind: 'TOOL_CALLS', calls, content },
        rawText: text,
        ...meta,
      };
    }

    const stopError = mapStopReason(response.stop_reason);
    if (stopError) return failure(stopError);
    if (text.trim() === '')
      return failure(invalidOutput('La respuesta llegó vacía.').error);
    if (!req.output)
      return {
        ok: true,
        value: { kind: 'FINAL', value: text as T, text },
        rawText: text,
        ...meta,
      };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return failure(invalidOutput('La respuesta no es JSON válido.').error);
    }
    const parsed = req.output.safeParse(json);
    if (!parsed.success)
      return failure(invalidOutput('La respuesta no cumple el esquema.').error);
    return {
      ok: true,
      value: { kind: 'FINAL', value: parsed.data, text },
      rawText: text,
      ...meta,
    };
  }

  private createSignal(external?: AbortSignal): Signals {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return {
      timeout,
      external,
      signal: external ? AbortSignal.any([external, timeout]) : timeout,
    };
  }

  private mapError(error: unknown, signals: Signals): AIError {
    // El orden importa: APIUserAbortError y APIConnectionError heredan de APIError.
    if (error instanceof APIUserAbortError || signals.signal.aborted) {
      if (signals.external?.aborted && !signals.timeout.aborted) {
        return {
          kind: 'TIMEOUT',
          retryable: false,
          message: 'Solicitud cancelada.',
        };
      }
      return timeoutError(this.timeoutMs);
    }
    if (error instanceof APIConnectionTimeoutError)
      return timeoutError(this.timeoutMs);
    if (error instanceof APIConnectionError) {
      return {
        kind: 'OFFLINE',
        retryable: true,
        message: 'Sin conexión con la API de Claude.',
      };
    }
    if (
      error instanceof AuthenticationError ||
      error instanceof PermissionDeniedError
    ) {
      return {
        kind: 'AUTH',
        retryable: false,
        message: `API key rechazada por la API de Claude (HTTP ${error.status}).`,
      };
    }
    if (error instanceof RateLimitError) {
      const retryAfterMs = parseRetryAfterMs(error.headers);
      return {
        kind: 'RATE_LIMIT',
        retryable: true,
        message: 'Límite de peticiones de la API de Claude alcanzado.',
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    if (error instanceof APIError && typeof error.status === 'number') {
      if (error.status >= 500) {
        // Incluye 529 (overloaded_error).
        return {
          kind: 'PROVIDER_DOWN',
          retryable: true,
          message: `La API de Claude no está disponible (HTTP ${error.status}).`,
        };
      }
      // 400, 404, 413…: la petición no es válida; reintentarla igual no sirve.
      const detail = apiErrorDetail(error);
      return {
        kind: 'PROVIDER_DOWN',
        retryable: false,
        message: `La API de Claude rechazó la petición (HTTP ${error.status}${error.type ? `, ${error.type}` : ''})${detail ? `: ${detail}` : '.'}`,
      };
    }
    return {
      kind: 'PROVIDER_DOWN',
      retryable: false,
      message: 'Error inesperado al llamar a la API de Claude.',
    };
  }
}

interface Signals {
  signal: AbortSignal;
  timeout: AbortSignal;
  external: AbortSignal | undefined;
}

function mapStopReason(
  stopReason: Anthropic.StopReason | null,
): AIError | null {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return null;
    case 'max_tokens':
      return {
        kind: 'INCOMPLETE',
        retryable: true,
        message: 'Respuesta cortada por el límite de tokens.',
      };
    case 'model_context_window_exceeded':
      return {
        kind: 'INCOMPLETE',
        retryable: false,
        message: 'La petición excede la ventana de contexto del modelo.',
      };
    case 'refusal':
      return {
        kind: 'UNSAFE',
        retryable: false,
        message: 'El modelo rechazó la petición.',
      };
    default:
      return invalidOutput(
        `Motivo de parada inesperado: ${String(stopReason)}.`,
      ).error;
  }
}

const MAX_DETAIL_LENGTH = 300;

/** Mensaje de error del cuerpo de la respuesta (`error.message`), recortado. No contiene la clave. */
function apiErrorDetail(error: APIError): string | undefined {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  if (typeof message !== 'string' || message.trim() === '') return undefined;
  return message.length > MAX_DETAIL_LENGTH
    ? `${message.slice(0, MAX_DETAIL_LENGTH)}…`
    : message;
}

function invalidOutput(message: string): { ok: false; error: AIError } {
  return {
    ok: false,
    error: { kind: 'INVALID_OUTPUT', retryable: true, message },
  };
}

function timeoutError(timeoutMs: number): AIError {
  return {
    kind: 'TIMEOUT',
    retryable: true,
    message: `Sin respuesta de la API de Claude en ${timeoutMs} ms.`,
  };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/** Lee `retry-after-ms` o `retry-after` (segundos o fecha HTTP) y lo devuelve en milisegundos. */
export function parseRetryAfterMs(
  headers: Headers | undefined,
  now: number = Date.now(),
): number | undefined {
  const ms = Number.parseFloat(headers?.get('retry-after-ms') ?? '');
  if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

// Palabras clave que las salidas estructuradas no admiten. Se quitan del esquema enviado;
// la respuesta igual se valida después con el esquema zod completo.
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'patternProperties',
  'additionalProperties',
]);
const SUPPORTED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);
const SCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'allOf', 'prefixItems']);
const SCHEMA_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions']);

/**
 * Convierte un esquema zod en el JSON Schema de `output_config.format`.
 * Conserva `enum`, `const`, `anyOf`, `$ref` y `required`; fuerza `additionalProperties: false`.
 */
export function toClaudeJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: 'output',
    unrepresentable: 'throw',
  });
  return cleanSchema(json);
}

/**
 * Esquema de una herramienta estricta: quita lo que el modo estricto no admite (longitudes,
 * patrones, maxItems…; el Core los vuelve a validar con zod al ejecutar) y aplana uniones
 * anidadas como `anyOf[anyOf[T, null], null]` en `anyOf[T, null]`. La API limita a 16 los
 * parámetros con unión por petición, sumando todas las herramientas y el esquema de salida.
 */
export function toClaudeToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return flattenUnions(cleanSchema(schema)) as Record<string, unknown>;
}

function flattenUnions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(flattenUnions);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node))
    out[key] = flattenUnions(value);
  if (Array.isArray(out.anyOf)) {
    const options: unknown[] = [];
    const seen = new Set<string>();
    const add = (option: unknown) => {
      const record = option as Record<string, unknown>;
      // Una opción que solo es otra unión se despliega en la de afuera.
      if (Object.keys(record).length === 1 && Array.isArray(record.anyOf)) {
        record.anyOf.forEach(add);
        return;
      }
      const key = JSON.stringify(option);
      if (!seen.has(key)) {
        seen.add(key);
        options.push(option);
      }
    };
    out.anyOf.forEach(add);
    out.anyOf = options;
  }
  return out;
}

function toClaudeTool(
  spec: AssistantToolSpec,
  strict: boolean,
): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    strict,
    input_schema: toClaudeToolSchema(
      spec.input_schema,
    ) as Anthropic.Tool.InputSchema,
  };
}

function toClaudeMessage(message: AssistantMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string')
    return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam =>
      block.type === 'text'
        ? { type: 'text', text: block.text }
        : block.type === 'tool_use'
          ? {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            }
          : {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              ...(block.is_error ? { is_error: true } : {}),
            },
    ),
  };
}

function cleanSchema(node: unknown): Record<string, unknown> {
  if (typeof node !== 'object' || node === null || Array.isArray(node))
    return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'format') {
      if (typeof value === 'string' && SUPPORTED_FORMATS.has(value))
        out.format = value;
    } else if (key === 'minItems') {
      if (typeof value === 'number' && value >= 1) out.minItems = 1;
    } else if (key === 'oneOf' && Array.isArray(value)) {
      out.anyOf = value.map(cleanSchema);
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map(cleanSchema);
    } else if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      typeof value === 'object' &&
      value !== null
    ) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, cleanSchema(sub)]),
      );
    } else if (
      (key === 'items' || key === 'not') &&
      typeof value === 'object'
    ) {
      out[key] = cleanSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object' || 'properties' in out)
    out.additionalProperties = false;
  // `type: ['string', 'null']` (nullable en zod) no está documentado: se expresa con `anyOf`.
  if (Array.isArray(out.type)) {
    const { type: types, description, ...rest } = out;
    return {
      ...(description !== undefined ? { description } : {}),
      anyOf: (types as unknown[]).map((type) =>
        type === 'null' ? { type } : cleanSchema({ ...rest, type }),
      ),
    };
  }
  return out;
}

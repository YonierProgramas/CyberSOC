import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ClaudeProvider,
  parseRetryAfterMs,
  toClaudeJsonSchema,
} from '../src/core/ai/providers/ClaudeProvider';
import {
  ANALYSIS_MAX_TOKENS,
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisRequest,
} from '../src/core/ai/prompts/analysis.v1';
import { aiAssessmentJsonSchema } from '../src/core/ai/schemas';

// Clave ficticia: nunca se envía a ningún sitio porque `fetch` está simulado.
const API_KEY = 'sk-ant-test-0000000000';
const MODEL = 'claude-haiku-4-5-20251001';

const Schema = z.strictObject({
  status: z.literal('ok'),
  model: z.string().min(1),
  level: z.enum(['LOW', 'HIGH']),
  tags: z.array(z.string()).min(2).optional(),
});
const request = {
  system: 'sistema',
  prompt: 'hola',
  schema: Schema,
  maxTokens: 300,
};

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call, init);
    },
  );
  return { fetch, calls };
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function message(text: string, stopReason = 'end_turn'): Response {
  return json(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 21, output_tokens: 9 },
  });
}

function apiError(
  status: number,
  type: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    { type: 'error', error: { type, message: 'simulado' } },
    headers,
  );
}

const validText = JSON.stringify({ status: 'ok', model: MODEL, level: 'LOW' });

function provider(handler: Handler, timeoutMs?: number) {
  const { fetch, calls } = fakeFetch(handler);
  const claude = new ClaudeProvider({
    apiKey: API_KEY,
    model: MODEL,
    fetch,
    timeoutMs,
  });
  return { claude, fetch, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ClaudeProvider: construcción', () => {
  it('exige apiKey y modelo explícitos aunque existan variables de entorno', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
    expect(() => new ClaudeProvider({ apiKey: '', model: MODEL })).toThrow(
      TypeError,
    );
    expect(() => new ClaudeProvider({ apiKey: '  ', model: MODEL })).toThrow(
      TypeError,
    );
    expect(() => new ClaudeProvider({ apiKey: API_KEY, model: '' })).toThrow(
      TypeError,
    );
  });

  it('no expone la clave al serializar o inspeccionar el proveedor', () => {
    const { claude } = provider(() => message(validText));
    expect(JSON.stringify(claude)).not.toContain(API_KEY);
    expect(inspect(claude, { depth: 10, showHidden: true })).not.toContain(
      API_KEY,
    );
  });
});

describe('ClaudeProvider.generateStructured', () => {
  it('envía la petición con output_config.format y valida la respuesta', async () => {
    const { claude, calls } = provider(() => message(validText));

    const result = await claude.generateStructured(request);

    expect(result).toEqual({
      ok: true,
      value: { status: 'ok', model: MODEL, level: 'LOW' },
      model: MODEL,
      usage: { inputTokens: 21, outputTokens: 9 },
      latencyMs: expect.any(Number),
      rawText: validText,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers.get('x-api-key')).toBe(API_KEY);
    expect(call.headers.get('authorization')).toBeNull();
    expect(call.body).toEqual({
      model: MODEL,
      max_tokens: 300,
      system: 'sistema',
      messages: [{ role: 'user', content: 'hola' }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', const: 'ok' },
              model: { type: 'string' },
              level: { type: 'string', enum: ['LOW', 'HIGH'] },
              tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['status', 'model', 'level'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('ignora ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN y ANTHROPIC_BASE_URL del entorno', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-env');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example');
    const { claude, calls } = provider(() => message(validText));

    await claude.generateStructured(request);

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers.get('x-api-key')).toBe(API_KEY);
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('omite system cuando no se indica', async () => {
    const { claude, calls } = provider(() => message(validText));
    await claude.generateStructured({
      prompt: 'hola',
      schema: Schema,
      maxTokens: 10,
    });
    expect(calls[0]?.body).not.toHaveProperty('system');
  });

  it.each([
    [401, 'authentication_error'],
    [403, 'permission_error'],
  ])('HTTP %i → AUTH no reintentable', async (status, type) => {
    const { claude } = provider(() => apiError(status, type));
    const result = await claude.generateStructured(request);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'AUTH',
        retryable: false,
        message: expect.stringContaining(String(status)),
      },
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('HTTP 429 → RATE_LIMIT con retryAfterMs de retry-after', async () => {
    const { claude } = provider(() =>
      apiError(429, 'rate_limit_error', { 'retry-after': '7' }),
    );
    await expect(claude.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'RATE_LIMIT',
        retryable: true,
        retryAfterMs: 7_000,
        message: expect.any(String),
      },
    });
  });

  it('HTTP 429 sin cabecera → RATE_LIMIT sin retryAfterMs', async () => {
    const { claude } = provider(() => apiError(429, 'rate_limit_error'));
    const result = await claude.generateStructured(request);
    expect(result.ok ? null : result.error).toEqual({
      kind: 'RATE_LIMIT',
      retryable: true,
      message: expect.any(String),
    });
  });

  it.each([
    [500, 'api_error'],
    [529, 'overloaded_error'],
  ])(
    'HTTP %i → PROVIDER_DOWN reintentable, sin reintentos internos del SDK',
    async (status, type) => {
      const { claude, fetch } = provider(() => apiError(status, type));
      const result = await claude.generateStructured(request);
      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'PROVIDER_DOWN',
          retryable: true,
          message: expect.stringContaining(String(status)),
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('HTTP 400 → PROVIDER_DOWN no reintentable, con el detalle de la API', async () => {
    const { claude } = provider(() =>
      json(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'schema: detalle' },
      }),
    );
    const result = await claude.generateStructured(request);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'PROVIDER_DOWN',
        retryable: false,
        message:
          'La API de Claude rechazó la petición (HTTP 400, invalid_request_error): schema: detalle',
      },
    });
  });

  it('error de red → OFFLINE', async () => {
    const { claude } = provider(() => {
      throw new TypeError('fetch failed');
    });
    await expect(claude.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: { kind: 'OFFLINE', retryable: true, message: expect.any(String) },
    });
  });

  it('timeout propio con AbortSignal → TIMEOUT reintentable', async () => {
    const { claude } = provider(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
      20,
    );
    await expect(claude.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'TIMEOUT',
        retryable: true,
        message: expect.stringContaining('20 ms'),
      },
    });
  });

  it('cancelación del llamador → TIMEOUT no reintentable', async () => {
    const controller = new AbortController();
    const { claude } = provider(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
          controller.abort();
        }),
    );
    const result = await claude.generateStructured({
      ...request,
      signal: controller.signal,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'TIMEOUT',
        retryable: false,
        message: 'Solicitud cancelada.',
      },
    });
  });

  it.each([
    ['max_tokens', 'INCOMPLETE', true],
    ['model_context_window_exceeded', 'INCOMPLETE', false],
    ['refusal', 'UNSAFE', false],
    ['tool_use', 'INVALID_OUTPUT', true],
  ])(
    'stop_reason=%s → %s (reintentable=%s)',
    async (stopReason, kind, retryable) => {
      const { claude } = provider(() => message(validText, stopReason));
      await expect(claude.generateStructured(request)).resolves.toEqual({
        ok: false,
        error: {
          kind,
          retryable,
          message: expect.any(String),
          // Se conserva la respuesta para auditoría y para AIResponseValidator.
          rawText: validText,
          usage: { inputTokens: 21, outputTokens: 9 },
          model: 'claude-haiku-4-5-20251001',
          latencyMs: expect.any(Number),
        },
      });
    },
  );

  it('max_tokens → INCOMPLETE aunque el texto cortado no sea JSON válido', async () => {
    const cut = '{"status": "ok", "model": "clau';
    const { claude } = provider(() => message(cut, 'max_tokens'));
    const result = await claude.generateStructured(request);
    expect(result.ok ? null : result.error).toMatchObject({
      kind: 'INCOMPLETE',
      retryable: true,
      rawText: cut,
    });
  });

  it.each([
    ['JSON inválido', '{"status": "ok"'],
    [
      'esquema inválido',
      JSON.stringify({ status: 'ok', model: '', level: 'MEDIUM' }),
    ],
  ])('%s → INVALID_OUTPUT reintentable', async (_name, text) => {
    const { claude } = provider(() => message(text));
    await expect(claude.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'INVALID_OUTPUT',
        retryable: true,
        message: expect.any(String),
        rawText: text,
        usage: { inputTokens: 21, outputTokens: 9 },
        model: 'claude-haiku-4-5-20251001',
        latencyMs: expect.any(Number),
      },
    });
  });

  it('una petición de análisis real envía el JSON Schema de ai-assessment/v1 y max_tokens de la tarea', async () => {
    const { claude, calls } = provider(() => message(validText));
    await claude.generateStructured(
      buildAnalysisRequest('{"schema":"cybersoc.ai-context/v1"}'),
    );
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(ANALYSIS_MAX_TOKENS);
    expect(body.system).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: aiAssessmentJsonSchema() },
    });
  });
});

describe('ClaudeProvider.healthCheck', () => {
  it('consulta el modelo configurado sin gastar tokens', async () => {
    const { claude, calls } = provider(() =>
      json(200, {
        type: 'model',
        id: MODEL,
        display_name: 'Claude Haiku 4.5',
        created_at: '2025-10-01T00:00:00Z',
      }),
    );
    await expect(claude.healthCheck()).resolves.toEqual({
      ok: true,
      value: { model: MODEL },
      model: MODEL,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: expect.any(Number),
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`https://api.anthropic.com/v1/models/${MODEL}`);
    expect(calls[0]?.headers.get('x-api-key')).toBe(API_KEY);
  });

  it('clave inválida → AUTH', async () => {
    const { claude } = provider(() => apiError(401, 'authentication_error'));
    const result = await claude.healthCheck();
    expect(result.ok ? null : result.error.kind).toBe('AUTH');
  });
});

describe('parseRetryAfterMs', () => {
  it('interpreta retry-after-ms, segundos y fecha HTTP', () => {
    const now = Date.parse('2026-10-01T15:00:00Z');
    expect(
      parseRetryAfterMs(new Headers({ 'retry-after-ms': '1500' }), now),
    ).toBe(1_500);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '2.5' }), now)).toBe(
      2_500,
    );
    expect(
      parseRetryAfterMs(
        new Headers({ 'retry-after': 'Thu, 01 Oct 2026 15:00:10 GMT' }),
        now,
      ),
    ).toBe(10_000);
    expect(
      parseRetryAfterMs(new Headers({ 'retry-after': 'basura' }), now),
    ).toBeUndefined();
    expect(parseRetryAfterMs(new Headers(), now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});

describe('toClaudeJsonSchema', () => {
  it('conserva la estructura y quita lo que las salidas estructuradas no admiten', () => {
    const schema = z.object({
      pattern: z.string().regex(/^a+$/),
      score: z.number().int().min(0).max(100),
      nested: z.object({ at: z.iso.datetime(), note: z.string().nullable() }),
      kind: z.union([z.literal('A'), z.literal('B')]),
    });
    expect(toClaudeJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        score: { type: 'integer' },
        nested: {
          type: 'object',
          properties: {
            at: { type: 'string', format: 'date-time' },
            note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['at', 'note'],
          additionalProperties: false,
        },
        kind: {
          anyOf: [
            { type: 'string', const: 'A' },
            { type: 'string', const: 'B' },
          ],
        },
      },
      required: ['pattern', 'score', 'nested', 'kind'],
      additionalProperties: false,
    });
  });
});

describe('ClaudeProvider.runAssistantTurn', () => {
  const turn = {
    system: 'reglas del copilot',
    messages: [
      { role: 'user' as const, content: 'pregunta 1' },
      { role: 'assistant' as const, content: 'respuesta 1' },
      { role: 'user' as const, content: 'pregunta 2' },
    ],
    maxTokens: 512,
  };

  it('envía system y mensajes sin herramientas ni salida estructurada, y devuelve el texto', async () => {
    const { claude, calls } = provider(() => message('Fue marcado por ev1.'));
    const result = await claude.runAssistantTurn({
      ...turn,
      model: 'claude-modelo-asistente',
    });
    expect(result).toMatchObject({
      ok: true,
      value: 'Fue marcado por ev1.',
      usage: { inputTokens: 21, outputTokens: 9 },
    });
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      model: 'claude-modelo-asistente',
      max_tokens: 512,
      system: 'reglas del copilot',
      messages: turn.messages,
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('output_config');
  });

  it('usa el modelo del proveedor si el turno no indica otro', async () => {
    const { claude, calls } = provider(() => message('ok'));
    await claude.runAssistantTurn(turn);
    expect((calls[0]!.body as { model: string }).model).toBe(MODEL);
  });

  it('copia solo role y content de cada mensaje', async () => {
    const { claude, calls } = provider(() => message('ok'));
    const extra = { role: 'user' as const, content: 'hola', secreto: 'x' };
    await claude.runAssistantTurn({ ...turn, messages: [extra] });
    expect((calls[0]!.body as { messages: unknown }).messages).toEqual([
      { role: 'user', content: 'hola' },
    ]);
  });

  it('rechaza una conversación vacía o que no termina en el usuario', async () => {
    const { claude, fetch } = provider(() => message('ok'));
    await expect(
      claude.runAssistantTurn({ ...turn, messages: [] }),
    ).rejects.toThrow(TypeError);
    await expect(
      claude.runAssistantTurn({
        ...turn,
        messages: [{ role: 'assistant', content: 'x' }],
      }),
    ).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [500, 'api_error', 'PROVIDER_DOWN', true],
    [529, 'overloaded_error', 'PROVIDER_DOWN', true],
    [401, 'authentication_error', 'AUTH', false],
    [429, 'rate_limit_error', 'RATE_LIMIT', true],
  ] as const)('HTTP %i → %s', async (status, type, kind, retryable) => {
    const { claude } = provider(() => apiError(status, type));
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({ ok: false, error: { kind, retryable } });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('error de red → OFFLINE', async () => {
    const { claude } = provider(() => {
      throw new TypeError('fetch failed');
    });
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({ ok: false, error: { kind: 'OFFLINE' } });
  });

  it('max_tokens → INCOMPLETE conservando el texto cortado', async () => {
    const { claude } = provider(() => message('Respuesta a me', 'max_tokens'));
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'INCOMPLETE', rawText: 'Respuesta a me' },
    });
  });

  it('refusal → UNSAFE', async () => {
    const { claude } = provider(() => message('', 'refusal'));
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({ ok: false, error: { kind: 'UNSAFE' } });
  });

  it('texto vacío → INVALID_OUTPUT', async () => {
    const { claude } = provider(() => message('   '));
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'INVALID_OUTPUT' },
    });
  });

  it('cancelación del llamador → TIMEOUT no reintentable', async () => {
    const controller = new AbortController();
    const { claude } = provider(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          controller.abort();
        }),
    );
    const result = await claude.runAssistantTurn({
      ...turn,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'TIMEOUT', retryable: false },
    });
  });
});

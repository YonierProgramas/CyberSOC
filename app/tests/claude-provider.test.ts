import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ClaudeProvider,
  parseRetryAfterMs,
  toClaudeJsonSchema,
  toClaudeToolSchema,
} from '../src/core/ai/providers/ClaudeProvider';
import {
  ANALYSIS_MAX_TOKENS,
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisRequest,
} from '../src/core/ai/prompts/analysis.v1';
import { aiAssessmentJsonSchema } from '../src/core/ai/schemas';

// Fake key: never sent anywhere because `fetch` is mocked.
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

describe('ClaudeProvider: construction', () => {
  it('requires explicit apiKey and model even if environment variables exist', () => {
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

  it('does not expose the key when serializing or inspecting the provider', () => {
    const { claude } = provider(() => message(validText));
    expect(JSON.stringify(claude)).not.toContain(API_KEY);
    expect(inspect(claude, { depth: 10, showHidden: true })).not.toContain(
      API_KEY,
    );
  });
});

describe('ClaudeProvider.generateStructured', () => {
  it('sends the request with output_config.format and validates the response', async () => {
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

  it('ignores ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL from the environment', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-env');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example');
    const { claude, calls } = provider(() => message(validText));

    await claude.generateStructured(request);

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers.get('x-api-key')).toBe(API_KEY);
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('omits system when not given', async () => {
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
  ])('HTTP %i → non-retryable AUTH', async (status, type) => {
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

  it('HTTP 429 → RATE_LIMIT with retryAfterMs from retry-after', async () => {
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

  it('HTTP 429 without header → RATE_LIMIT without retryAfterMs', async () => {
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
    'HTTP %i → retryable PROVIDER_DOWN, without internal SDK retries',
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

  it('HTTP 400 → non-retryable PROVIDER_DOWN, with the API detail', async () => {
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

  it('network error → OFFLINE', async () => {
    const { claude } = provider(() => {
      throw new TypeError('fetch failed');
    });
    await expect(claude.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: { kind: 'OFFLINE', retryable: true, message: expect.any(String) },
    });
  });

  it('own timeout with AbortSignal → retryable TIMEOUT', async () => {
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

  it('caller cancellation → non-retryable TIMEOUT', async () => {
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
          // The response is kept for audit and for AIResponseValidator.
          rawText: validText,
          usage: { inputTokens: 21, outputTokens: 9 },
          model: 'claude-haiku-4-5-20251001',
          latencyMs: expect.any(Number),
        },
      });
    },
  );

  it('max_tokens → INCOMPLETE even if the cut-off text is not valid JSON', async () => {
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

  it('a real analysis request sends the ai-assessment/v1 JSON Schema and the task max_tokens', async () => {
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
  it('queries the configured model without spending tokens', async () => {
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

  it('invalid key → AUTH', async () => {
    const { claude } = provider(() => apiError(401, 'authentication_error'));
    const result = await claude.healthCheck();
    expect(result.ok ? null : result.error.kind).toBe('AUTH');
  });
});

describe('parseRetryAfterMs', () => {
  it('interprets retry-after-ms, seconds and HTTP date', () => {
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
  it('keeps the structure and removes what structured outputs do not support', () => {
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

  it('sends system and messages without tools or structured output, and returns the text', async () => {
    const { claude, calls } = provider(() => message('Fue marcado por ev1.'));
    const result = await claude.runAssistantTurn({
      ...turn,
      model: 'claude-modelo-asistente',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: 'FINAL',
        value: 'Fue marcado por ev1.',
        text: 'Fue marcado por ev1.',
      },
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

  it('uses the provider model if the turn gives no other', async () => {
    const { claude, calls } = provider(() => message('ok'));
    await claude.runAssistantTurn(turn);
    expect((calls[0]!.body as { model: string }).model).toBe(MODEL);
  });

  it('copies only role and content of each message', async () => {
    const { claude, calls } = provider(() => message('ok'));
    const extra = { role: 'user' as const, content: 'hola', secreto: 'x' };
    await claude.runAssistantTurn({ ...turn, messages: [extra] });
    expect((calls[0]!.body as { messages: unknown }).messages).toEqual([
      { role: 'user', content: 'hola' },
    ]);
  });

  it('rejects an empty conversation or one not ending with the user', async () => {
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

  it('network error → OFFLINE', async () => {
    const { claude } = provider(() => {
      throw new TypeError('fetch failed');
    });
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({ ok: false, error: { kind: 'OFFLINE' } });
  });

  it('max_tokens → INCOMPLETE keeping the cut-off text', async () => {
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

  it('empty text → INVALID_OUTPUT', async () => {
    const { claude } = provider(() => message('   '));
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'INVALID_OUTPUT' },
    });
  });

  it('caller cancellation → non-retryable TIMEOUT', async () => {
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

describe('ClaudeProvider.runAssistantTurn with strict tools and structured output (S5)', () => {
  const Output = z.strictObject({ answer: z.string().min(1) });
  const tool = {
    name: 'get_result_detail',
    description: 'Detalle de un resultado.',
    strict: true as const,
    input_schema: {
      type: 'object',
      properties: {
        resultId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^r',
        },
        jobId: {
          anyOf: [
            { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
            { type: 'null' },
          ],
        },
      },
      required: ['resultId', 'jobId'],
      additionalProperties: false,
    },
  };
  const turn = {
    system: 'reglas v2',
    messages: [{ role: 'user' as const, content: 'pregunta' }],
    maxTokens: 2048,
    tools: [tool],
    output: Output,
  };

  function toolUse(): Response {
    return json(200, {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [
        { type: 'text', text: 'Consulto el resultado.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'get_result_detail',
          input: { resultId: 'r1', jobId: null },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 20 },
    });
  }

  it('sends tools with strict: true and output_config.format in the SAME request', async () => {
    const { claude, calls } = provider(() => message('{"answer":"ok"}'));
    await claude.runAssistantTurn(turn);
    const body = calls[0]!.body as {
      tools: Array<{
        name: string;
        strict: boolean;
        input_schema: Record<string, unknown>;
      }>;
      output_config: {
        format: { type: string; schema: Record<string, unknown> };
      };
    };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      name: 'get_result_detail',
      strict: true,
    });
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema).toMatchObject({
      type: 'object',
      required: ['answer'],
      additionalProperties: false,
    });
    // The tool schema arrives clean: no lengths or patterns and no nested unions.
    expect(body.tools[0]!.input_schema).toEqual({
      type: 'object',
      properties: {
        resultId: { type: 'string' },
        jobId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['resultId', 'jobId'],
      additionalProperties: false,
    });
  });

  it('stop_reason tool_use → TOOL_CALLS with the calls and the content to resend', async () => {
    const { claude } = provider(() => toolUse());
    const result = await claude.runAssistantTurn(turn);
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: 'TOOL_CALLS',
        calls: [
          {
            id: 'toolu_01',
            name: 'get_result_detail',
            input: { resultId: 'r1', jobId: null },
          },
        ],
        content: [
          { type: 'text', text: 'Consulto el resultado.' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'get_result_detail',
            input: { resultId: 'r1', jobId: null },
          },
        ],
      },
      usage: { inputTokens: 50, outputTokens: 20 },
    });
  });

  it('resends tool_use and tool_result (with is_error) in the API format', async () => {
    const { claude, calls } = provider(() => message('{"answer":"listo"}'));
    const history = [
      { role: 'user' as const, content: 'pregunta' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 'toolu_01',
            name: 'get_result_detail',
            input: { resultId: 'r1', jobId: null },
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'toolu_01',
            content: '{"ok":false}',
            is_error: true,
          },
          {
            type: 'tool_result' as const,
            tool_use_id: 'toolu_02',
            content: '{"ok":true}',
          },
        ],
      },
    ];
    await claude.runAssistantTurn({ ...turn, messages: history });
    expect((calls[0]!.body as { messages: unknown[] }).messages).toEqual(
      history,
    );
  });

  it('end_turn → FINAL validated with the output schema', async () => {
    const { claude } = provider(() =>
      message('{"answer":"Fue por ev1 (SIGNATURES)."}'),
    );
    await expect(claude.runAssistantTurn(turn)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'FINAL', value: { answer: 'Fue por ev1 (SIGNATURES).' } },
    });
  });

  it.each([
    ['texto que no es JSON', 'hola', 'La respuesta no es JSON válido.'],
    [
      'JSON fuera del esquema',
      '{"answer":""}',
      'La respuesta no cumple el esquema.',
    ],
    [
      'campos extra',
      '{"answer":"x","verdict":"CLEAN"}',
      'La respuesta no cumple el esquema.',
    ],
  ])('%s → INVALID_OUTPUT', async (_name, text, messageText) => {
    const { claude } = provider(() => message(text));
    await expect(claude.runAssistantTurn(turn)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'INVALID_OUTPUT', message: messageText, rawText: text },
    });
  });

  it("toolChoice 'none' (phase 2): tools only declared, without strict, and tool_choice none", async () => {
    const { claude, calls } = provider(() => message('{"answer":"ok"}'));
    await claude.runAssistantTurn({ ...turn, toolChoice: 'none' });
    const body = calls[0]!.body as {
      tools: Array<{ strict: boolean }>;
      tool_choice: unknown;
      output_config: unknown;
    };
    expect(body.tools[0]!.strict).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.output_config).toBeDefined();
  });

  it('phase 1 (without output): strict tools and no output_config or tool_choice', async () => {
    const { claude, calls } = provider(() => message('Texto libre.'));
    const result = await claude.runAssistantTurn({
      system: 's',
      messages: turn.messages,
      maxTokens: 100,
      tools: [tool],
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect((body.tools as Array<{ strict: boolean }>)[0]!.strict).toBe(true);
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('tool_choice');
    expect(result).toMatchObject({
      ok: true,
      value: { kind: 'FINAL', value: 'Texto libre.', text: 'Texto libre.' },
    });
  });

  it('tool_use without declared tools → INVALID_OUTPUT', async () => {
    const { claude } = provider(() => toolUse());
    await expect(
      claude.runAssistantTurn({
        system: 's',
        messages: turn.messages,
        maxTokens: 100,
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'INVALID_OUTPUT' } });
  });
});

describe('toClaudeToolSchema', () => {
  it('flattens nested unions, removes null duplicates and keeps enums', () => {
    expect(
      toClaudeToolSchema({
        type: 'object',
        properties: {
          zone: {
            anyOf: [
              {
                anyOf: [
                  { type: 'string', enum: ['DESCARGAS', 'SISTEMA'] },
                  { type: 'null' },
                ],
              },
              { type: 'null' },
            ],
          },
          verdicts: {
            anyOf: [
              {
                minItems: 1,
                maxItems: 5,
                type: 'array',
                items: { type: 'string', enum: ['CLEAN'] },
              },
              { type: 'null' },
            ],
          },
        },
        required: ['zone', 'verdicts'],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        zone: {
          anyOf: [
            { type: 'string', enum: ['DESCARGAS', 'SISTEMA'] },
            { type: 'null' },
          ],
        },
        verdicts: {
          anyOf: [
            {
              minItems: 1,
              type: 'array',
              items: { type: 'string', enum: ['CLEAN'] },
            },
            { type: 'null' },
          ],
        },
      },
      required: ['zone', 'verdicts'],
      additionalProperties: false,
    });
  });
});

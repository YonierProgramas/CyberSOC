import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AIErrorKind } from '../src/core/ai/AIProvider';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';

const Schema = z.strictObject({ status: z.literal('ok'), model: z.string() });
const request = { prompt: 'hola', schema: Schema, maxTokens: 100 };

describe('FakeAIProvider', () => {
  it('devuelve salidas estructuradas válidas en orden FIFO', async () => {
    const fake = new FakeAIProvider({ model: 'fake-1' })
      .enqueueValue(
        { status: 'ok', model: 'a' },
        { usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 42 },
      )
      .enqueueValue({ status: 'ok', model: 'b' }, { model: 'otro' });

    expect(fake.id).toBe('fake');
    expect(fake.pending).toBe(2);
    await expect(fake.generateStructured(request)).resolves.toEqual({
      ok: true,
      value: { status: 'ok', model: 'a' },
      model: 'fake-1',
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 42,
    });
    await expect(fake.generateStructured(request)).resolves.toMatchObject({
      ok: true,
      value: { model: 'b' },
      model: 'otro',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(fake.pending).toBe(0);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.prompt).toBe('hola');
  });

  it('valida la respuesta programada contra el esquema de la petición', async () => {
    const fake = new FakeAIProvider().enqueueValue({ status: 'mal', model: 1 });
    await expect(fake.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'INVALID_OUTPUT',
        retryable: true,
        message: expect.any(String),
      },
    });
  });

  it.each<[AIErrorKind, boolean]>([
    ['OFFLINE', true],
    ['TIMEOUT', true],
    ['AUTH', false],
    ['PROVIDER_DOWN', true],
    ['INVALID_OUTPUT', true],
    ['INCOMPLETE', true],
    ['UNSAFE', false],
  ])('simula el error %s con reintentable=%s', async (kind, retryable) => {
    const fake = new FakeAIProvider().enqueueError(kind);
    const result = await fake.generateStructured(request);
    expect(result).toEqual({
      ok: false,
      error: { kind, retryable, message: expect.any(String) },
    });
  });

  it('simula RATE_LIMIT con retryAfterMs', async () => {
    const fake = new FakeAIProvider()
      .enqueueError('RATE_LIMIT', { retryAfterMs: 5_000, message: 'espera' })
      .enqueueError('RATE_LIMIT');
    await expect(fake.generateStructured(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: 'RATE_LIMIT',
        retryable: true,
        retryAfterMs: 5_000,
        message: 'espera',
      },
    });
    const second = await fake.generateStructured(request);
    expect(second.ok ? null : second.error.retryAfterMs).toBe(1_000);
  });

  it('permite sobrescribir la reintentabilidad', async () => {
    const fake = new FakeAIProvider().enqueueError('INVALID_OUTPUT', {
      retryable: false,
    });
    const result = await fake.generateStructured(request);
    expect(result.ok ? null : result.error.retryable).toBe(false);
  });

  it('mezcla errores y valores, como una secuencia de reintentos', async () => {
    const fake = new FakeAIProvider()
      .enqueueError('TIMEOUT')
      .enqueueValue({ status: 'ok', model: 'x' });
    expect((await fake.generateStructured(request)).ok).toBe(false);
    expect((await fake.generateStructured(request)).ok).toBe(true);
  });

  it('lanza si se llama sin respuestas programadas (error de la prueba)', async () => {
    await expect(
      new FakeAIProvider().generateStructured(request),
    ).rejects.toThrow(/no hay respuestas/);
  });

  it('respeta una señal ya cancelada sin consumir la cola', async () => {
    const fake = new FakeAIProvider().enqueueValue({
      status: 'ok',
      model: 'x',
    });
    const controller = new AbortController();
    controller.abort();
    const result = await fake.generateStructured({
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
    expect(fake.pending).toBe(1);
  });

  it('healthCheck responde bien por defecto y puede fallar a demanda', async () => {
    const fake = new FakeAIProvider({ model: 'fake-2' });
    await expect(fake.healthCheck()).resolves.toMatchObject({
      ok: true,
      value: { model: 'fake-2' },
    });

    fake.setHealthError('AUTH');
    await expect(fake.healthCheck()).resolves.toEqual({
      ok: false,
      error: { kind: 'AUTH', retryable: false, message: expect.any(String) },
    });

    fake.setHealthError(null);
    expect((await fake.healthCheck()).ok).toBe(true);
  });
});

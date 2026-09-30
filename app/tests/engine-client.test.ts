import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcEngineClient } from '../src/core/engine/JsonRpcEngineClient';

describe('JsonRpcEngineClient', () => {
  let client: JsonRpcEngineClient;
  let input: PassThrough;
  let output: PassThrough;
  let lifecycle: EventEmitter;
  let requests: { id: number; method: string; params: unknown }[];
  beforeEach(() => {
    vi.useFakeTimers();
    input = new PassThrough();
    output = new PassThrough();
    lifecycle = new EventEmitter();
    requests = [];
    input.on('data', (data: Buffer) =>
      requests.push(JSON.parse(data.toString('utf8'))),
    );
    client = new JsonRpcEngineClient(
      { input, output, lifecycle },
      { timeoutMs: 100 },
    );
  });
  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });
  function respond(id: number, result: unknown) {
    output.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  it('correlaciona respuestas fuera de orden y fragmentadas por id', async () => {
    const first = client.ping();
    const second = client.ping();
    expect(requests.map((r) => r.id)).toEqual([1, 2]);
    const ts1 = '2026-09-29T12:00:00Z';
    const ts2 = '2026-09-29T12:01:00Z';
    const line = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { ts: ts2 } });
    output.write(line.slice(0, 15));
    output.write(line.slice(15) + '\n');
    respond(1, { ts: ts1 });
    await expect(first).resolves.toEqual({ ts: ts1 });
    await expect(second).resolves.toEqual({ ts: ts2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('vence una peticion e ignora respuestas tardias sin afectar a otra', async () => {
    const first = expect(client.ping()).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const second = client.ping();
    respond(1, { ts: '2026-09-29T12:00:00Z' });
    respond(2, { ts: '2026-09-29T12:01:00Z' });
    await expect(second).resolves.toHaveProperty('ts');
  });

  it('rechaza todas las pendientes cuando muere el proceso', async () => {
    const checks = [
      expect(client.ping()).rejects.toThrow('termino'),
      expect(client.ping()).rejects.toThrow('termino'),
    ];
    lifecycle.emit('exit', 1, null);
    await Promise.all(checks);
    await expect(client.ping()).rejects.toThrow('desconectado');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propaga errores JSON-RPC conservando su codigo', async () => {
    const check = expect(client.ping()).rejects.toMatchObject({ code: -32603 });
    output.write(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal error"}}\n',
    );
    await check;
  });

  it.each([
    'not json\n',
    '{"jsonrpc":"2.0","id":1}\n',
    '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n',
  ])('rechaza respuesta invalida: %s', async (line) => {
    const check = expect(client.ping()).rejects.toThrow('invalida');
    output.write(line);
    await check;
  });

  it('hello usa 5 segundos independientemente del timeout general', async () => {
    const check = expect(client.hello()).rejects.toThrow('5000 ms');
    expect(requests[0]).toMatchObject({
      method: 'engine.hello',
      params: { protocol: '1' },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
  });

  it('detecta protocolo incompatible', async () => {
    const check = expect(client.hello()).rejects.toMatchObject({
      protocol: '2',
    });
    respond(1, {
      protocol: '2',
      engineVersion: '9',
      python: '3.12',
      capabilities: [],
    });
    await check;
  });

  it('rechaza pendientes por error de escritura', async () => {
    const check = expect(client.ping()).rejects.toThrow('EPIPE');
    input.emit('error', new Error('EPIPE'));
    await check;
    input.emit('error', new Error('late EPIPE'));
  });
});

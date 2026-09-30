import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import {
  engineResultSchema,
  scanFileParamsSchema,
  type EngineResult,
  type ScanFileParams,
} from '../../shared/protocol';
import {
  IncompatibleEngineError,
  RpcRemoteError,
  RpcTimeoutError,
  type EngineClient,
  type EngineInfo,
} from './EngineClient';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcTransport {
  input: Writable;
  output: Readable;
  lifecycle: EventEmitter;
}

const responseSchema = z.union([
  z
    .strictObject({
      jsonrpc: z.literal('2.0'),
      id: z.number().int(),
      result: z.unknown(),
    })
    .refine((value) => Object.hasOwn(value, 'result')),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id: z.number().int(),
    error: z.object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);
const helloSchema = z.object({
  protocol: z.string(),
  engineVersion: z.string(),
  python: z.string(),
  capabilities: z.array(z.string()),
});

export class JsonRpcEngineClient implements EngineClient {
  private readonly pending = new Map<number, Pending>();
  private readonly lines: Interface;
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly transport: RpcTransport,
    private readonly options: {
      timeoutMs?: number;
      onDisconnect?: (error: Error) => void;
    } = {},
  ) {
    this.lines = createInterface({
      input: transport.output,
      crlfDelay: Infinity,
    });
    this.lines.on('line', this.onLine);
    this.lines.on('close', this.onEnd);
    transport.lifecycle.on('exit', this.onExit);
    transport.lifecycle.on('error', this.onError);
    transport.input.on('error', this.onError);
    transport.output.on('error', this.onError);
  }

  async hello(): Promise<EngineInfo> {
    const info = helloSchema.parse(
      await this.request(
        'engine.hello',
        {
          protocol: '1',
          client: 'cybersoc-core/0.0.1',
        },
        5_000,
      ),
    );
    if (info.protocol !== '1')
      throw new IncompatibleEngineError(info.protocol, info.engineVersion);
    return { ...info, protocol: '1' };
  }

  async ping(): Promise<{ ts: string }> {
    return z
      .object({ ts: z.iso.datetime() })
      .parse(await this.request('engine.ping', {}));
  }

  async shutdown(): Promise<void> {
    z.object({ ok: z.literal(true) }).parse(
      await this.request('engine.shutdown', {}),
    );
  }

  async scanFile(
    params: ScanFileParams,
    timeoutMs: number,
  ): Promise<EngineResult> {
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    ) {
      throw new RangeError('Timeout de archivo inválido.');
    }
    const result = engineResultSchema.parse(
      await this.request(
        'scan.file',
        scanFileParamsSchema.parse(params),
        timeoutMs,
      ),
    );
    if (result.taskId !== params.taskId)
      throw new RpcRemoteError(-32603, 'Respuesta para otra tarea de escaneo.');
    return result;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.options.timeoutMs ?? 5_000,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Motor desconectado.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        this.transport.input.write(message + '\n', 'utf8', (error) => {
          if (error) this.onError(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  dispose(error = new Error('Motor desconectado.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.lines.off('line', this.onLine);
    this.lines.off('close', this.onEnd);
    this.lines.close();
    this.transport.lifecycle.off('exit', this.onExit);
    // Keep error listeners until the streams close: late EPIPE must not crash main.
    this.options.onDisconnect?.(error);
  }

  private readonly onEnd = () =>
    this.dispose(new Error('Se cerro stdout del motor.'));
  private readonly onExit = () =>
    this.dispose(new Error('El proceso del motor termino.'));
  private readonly onError = (error: Error) => this.dispose(error);
  private readonly onLine = (line: string) => {
    try {
      const response = responseSchema.parse(JSON.parse(line));
      const pending = this.pending.get(response.id);
      if (!pending) return; // Includes late replies after a timeout.
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if ('error' in response)
        pending.reject(
          new RpcRemoteError(response.error.code, response.error.message),
        );
      else pending.resolve(response.result);
    } catch {
      this.dispose(new Error('Respuesta JSON-RPC invalida del motor.'));
    }
  };
}

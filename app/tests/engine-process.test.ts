import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineProcess,
  parseEngineCommand,
} from '../src/core/engine/EngineProcess';

function fixture(
  options: {
    protocol?: string;
    hangHello?: boolean;
    hangShutdown?: boolean;
    stayAfterShutdown?: boolean;
    failSpawn?: boolean;
    hangScan?: boolean;
  } = {},
) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: options.failSpawn ? undefined : 42,
    stdin: new PassThrough() as Writable,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    }),
  });
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString());
      done();
      queueMicrotask(() => {
        if (request.method === 'scan.file' && !options.hangScan) {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                taskId: request.params.taskId,
                status: 'SKIPPED',
                evidence: [],
                layers: [],
                durationMs: 0,
                engineVersion: '0.1.0',
                error: { code: 'TOO_LARGE', message: 'grande' },
              },
            }) + '\n',
          );
        }
        if (
          request.method === 'engine.hello' &&
          !options.hangHello &&
          !options.failSpawn
        ) {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocol: options.protocol ?? '1',
                engineVersion: '0.0.1',
                python: '3.12.13',
                capabilities: [],
              },
            }) + '\n',
          );
        }
        if (
          request.method === 'engine.shutdown' &&
          !options.hangShutdown &&
          !options.failSpawn
        ) {
          child.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { ok: true },
            }) + '\n',
          );
          if (!options.stayAfterShutdown) child.emit('exit', 0, null);
        }
      });
    },
  });
  const spawnProcess = vi.fn(() => {
    if (options.failSpawn)
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  });
  const logger = { info: vi.fn(), error: vi.fn() };
  const engine = new EngineProcess({
    command: () => ({ file: 'python', args: ['-m', 'cybersoc_engine'] }),
    cwd: process.cwd(),
    logger,
    spawnProcess: spawnProcess as unknown as typeof spawn,
  });
  return { engine, child, spawnProcess, logger };
}

afterEach(() => vi.useRealTimers());

describe('EngineProcess', () => {
  it('exposes validated scanFile when connected', async () => {
    const { engine } = fixture();
    const params = {
      jobId: 'j1',
      taskId: 't1',
      path: 'C:\\ñ.txt',
      options: { maxBytes: 100 },
    };
    await expect(engine.scanFile(params, 100)).rejects.toThrow('desconectado');
    await engine.reconnect();
    await expect(engine.scanFile(params, 100)).resolves.toMatchObject({
      taskId: 't1',
      status: 'SKIPPED',
    });
    await engine.close();
  });

  it('reconnect kills the stuck process after timeout and creates a new one', async () => {
    vi.useFakeTimers();
    const { engine, child, spawnProcess } = fixture({
      hangScan: true,
      hangShutdown: true,
    });
    await engine.reconnect();
    const check = expect(
      engine.scanFile(
        {
          jobId: 'j1',
          taskId: 't1',
          path: 'C:\\ñ.txt',
          options: { maxBytes: 100 },
        },
        100,
      ),
    ).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(100);
    await check;
    const reconnect = engine.reconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect((await reconnect).status).toBe('connected');
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    const closing = engine.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('connects, forwards stderr and closes cleanly', async () => {
    const { engine, child, spawnProcess, logger } = fixture();
    expect(await engine.reconnect()).toEqual({
      status: 'connected',
      engineVersion: '0.0.1',
      protocol: '1',
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      'python',
      ['-m', 'cybersoc_engine'],
      expect.objectContaining({ windowsHide: true, shell: false }),
    );
    child.stderr.write('mensaje\n');
    expect(logger.info).toHaveBeenCalledWith('mensaje', {
      component: 'engine',
    });
    await engine.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(engine.getState().status).toBe('disconnected');
  });
  it('keeps stderr JSON fields with component engine', async () => {
    const { engine, child, logger } = fixture();
    await engine.reconnect();
    child.stderr.write(
      `${JSON.stringify({
        timestamp: '2026-10-01T15:00:00.000Z',
        level: 'INFO',
        component: 'other',
        message: 'Engine started',
        rpc_code: -32601,
      })}\n`,
    );
    child.stderr.write(
      `${JSON.stringify({
        level: 'ERROR',
        message: 'boom',
        error_type: 'RuntimeError',
      })}\n`,
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Engine started',
      expect.objectContaining({
        component: 'engine',
        timestamp: '2026-10-01T15:00:00.000Z',
        level: 'INFO',
        message: 'Engine started',
        rpc_code: -32601,
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'boom',
      expect.objectContaining({
        component: 'engine',
        level: 'ERROR',
        error_type: 'RuntimeError',
      }),
    );
    await engine.close();
  });
  it('reflects the process death immediately', async () => {
    const { engine, child } = fixture();
    await engine.reconnect();
    child.emit('exit', 1, null);
    expect(engine.getState().status).toBe('disconnected');
    await engine.close();
  });
  it('distinguishes incompatibility and stops that process', async () => {
    const { engine } = fixture({ protocol: '2' });
    expect(await engine.reconnect()).toEqual({
      status: 'incompatible',
      engineVersion: '0.0.1',
      protocol: '2',
    });
    await engine.close();
  });
  it('handles a nonexistent executable without hanging', async () => {
    const { engine } = fixture({ failSpawn: true });
    expect((await engine.reconnect()).status).toBe('disconnected');
    await engine.close();
  });
  it.each([false, true])(
    'kills after 2 seconds if the process is still alive (shutdown answered: %s)',
    async (acknowledge) => {
      vi.useFakeTimers();
      const { engine, child } = fixture({
        hangShutdown: !acknowledge,
        stayAfterShutdown: acknowledge,
      });
      const ready = engine.reconnect();
      await vi.advanceTimersByTimeAsync(0);
      await ready;
      const closed = engine.close();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    },
  );
  it('exhausts the handshake after 5 seconds', async () => {
    vi.useFakeTimers();
    const { engine } = fixture({ hangHello: true });
    const ready = engine.reconnect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await ready).status).toBe('disconnected');
    await engine.close();
  });
  it('coalesces reconnects and closes during a pending handshake', async () => {
    const { engine, spawnProcess } = fixture({ hangHello: true });
    const ready = engine.reconnect();
    expect(engine.reconnect()).toBe(ready);
    await Promise.resolve();
    await engine.close();
    await ready;
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await expect(engine.reconnect()).rejects.toThrow('cerrando');
  });
});

describe('CYBERSOC_ENGINE_CMD', () => {
  it('keeps Windows paths with spaces and does not expand operators', () => {
    expect(
      parseEngineCommand('"C:\\Motor Python\\python.exe" -m cybersoc_engine'),
    ).toEqual({
      file: 'C:\\Motor Python\\python.exe',
      args: ['-m', 'cybersoc_engine'],
    });
    expect(parseEngineCommand('python x & y').args).toEqual(['x', '&', 'y']);
  });
  it('admite argv JSON', () => {
    expect(parseEngineCommand('["python","-m","cybersoc_engine"]')).toEqual({
      file: 'python',
      args: ['-m', 'cybersoc_engine'],
    });
  });
  it.each(['', '"unfinished', '[]'])(
    'rejects invalid command %s',
    (command) => {
      expect(() => parseEngineCommand(command)).toThrow();
    },
  );
});

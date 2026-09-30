import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asEngineLogger,
  EngineProcess,
} from '../src/core/engine/EngineProcess';
import {
  createLogger,
  logFileName,
  type AppLogger,
} from '../src/core/logging/logger';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(() => 'unused-user-data'),
}));
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
}));

function readLogs(logger: AppLogger): Array<Record<string, unknown>> {
  logger.flush();
  return readFileSync(logger.filePath(), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function engineWith(logger: AppLogger) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    stdin: new PassThrough() as Writable,
    kill: vi.fn(() => true),
  });
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString()) as {
        method: string;
        id: number;
      };
      done();
      queueMicrotask(() => {
        if (request.method === 'engine.hello') {
          child.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocol: '1',
                engineVersion: '0.0.1',
                python: '3.12.13',
                capabilities: [],
              },
            })}\n`,
          );
        }
        if (request.method === 'engine.shutdown') {
          child.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { ok: true },
            })}\n`,
          );
          child.emit('exit', 0, null);
        }
      });
    },
  });
  const engine = new EngineProcess({
    command: () => ({ file: 'python', args: ['-m', 'cybersoc_engine'] }),
    cwd: process.cwd(),
    logger: asEngineLogger(logger),
    spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
  });
  return { engine, child };
}

describe('logger JSONL', () => {
  afterEach(() => {
    mocks.getPath.mockReset();
    mocks.getPath.mockReturnValue('unused-user-data');
  });

  function logsDirectory(): string {
    return mkdtempSync(join(tmpdir(), 'cybersoc-logs-'));
  }

  it('escribe entradas del core y del motor con ts, level, component y msg', async () => {
    const logger = createLogger(logsDirectory());
    logger.info({ component: 'core' }, 'Logging started');
    const { engine, child } = engineWith(logger);
    await engine.reconnect();
    child.stderr.write(
      `${JSON.stringify({
        timestamp: '2026-10-01T15:00:00.000Z',
        level: 'INFO',
        component: 'engine',
        message: 'Engine started',
        rpc_code: -32601,
      })}\n`,
    );
    child.stderr.write('linea plana\n');
    const entries = readLogs(logger);
    expect(entries.map((entry) => entry.component)).toEqual([
      'core',
      'engine',
      'engine',
    ]);
    for (const entry of entries) {
      expect(entry.ts).toEqual(expect.any(String));
      expect(entry.level).toEqual(expect.any(String));
      expect(entry.component).toEqual(expect.any(String));
      expect(entry.msg).toEqual(expect.any(String));
    }
    expect(entries[1]).toMatchObject({
      component: 'engine',
      level: 'INFO',
      msg: 'Engine started',
      timestamp: '2026-10-01T15:00:00.000Z',
      rpc_code: -32601,
    });
    expect(entries[2]).toMatchObject({
      component: 'engine',
      level: 'info',
      msg: 'linea plana',
    });
    expect(logger.filePath().endsWith(logFileName())).toBe(true);
    await engine.close();
  });

  it('no escribe apiKey, authorization, x-api-key ni contenido de archivo', () => {
    const apiKey = 'sk-live-api-key-value';
    const authorization = 'Bearer auth-header-value';
    const apiHeader = 'x-api-key-value';
    const fileBody = 'BEGIN-FILE-BYTES-SHOULD-NOT-LEAK';
    const logger = createLogger(logsDirectory());
    logger.info(
      {
        component: 'core',
        apiKey,
        headers: {
          Authorization: authorization,
          'X-Api-Key': apiHeader,
        },
        nested: [{ apiKey }],
        content: fileBody,
        fileContent: fileBody,
      },
      `apiKey=${apiKey}`,
    );
    logger.flush();
    const raw = readFileSync(logger.filePath(), 'utf8');
    expect(raw).not.toContain(apiKey);
    expect(raw).not.toContain('auth-header-value');
    expect(raw).not.toContain(apiHeader);
    expect(raw).not.toContain(fileBody);
    expect(raw).toContain('[Redacted]');
    const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(entry).toMatchObject({
      component: 'core',
      level: 'info',
      apiKey: '[Redacted]',
      content: '[Redacted]',
    });
  });
});

describe('composition root', () => {
  it('inyecta userData/logs cuando main no pasa la ruta', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'cybersoc-userdata-'));
    mocks.getPath.mockReturnValue(userData);
    const { createEngine } = await import('../src/main/composition-root');
    const engine = createEngine(process.cwd());
    expect(mocks.getPath).toHaveBeenCalledWith('userData');
    const file = join(userData, 'logs', logFileName());
    const entry = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      component: 'core',
      level: 'info',
      msg: 'Logging started',
    });
    expect(entry.ts).toEqual(expect.any(String));
    await engine.close();
  });
});

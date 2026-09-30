import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { EngineState } from '../../shared/ipc';
import type { EngineResult, ScanFileParams } from '../../shared/protocol';
import { IncompatibleEngineError, RpcRemoteError } from './EngineClient';
import { JsonRpcEngineClient } from './JsonRpcEngineClient';

export interface EngineCommand {
  file: string;
  args: string[];
}
export interface EngineLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  log?(level: string, message: string, fields?: Record<string, unknown>): void;
}

export function asEngineLogger(logger: {
  write(
    level: string,
    fields: { component: string; [key: string]: unknown },
    message: string,
  ): void;
}): EngineLogger {
  return {
    info(message, fields = {}) {
      logger.write('info', { ...fields, component: 'engine' }, message);
    },
    error(message, fields = {}) {
      logger.write('error', { ...fields, component: 'engine' }, message);
    },
    log(level, message, fields = {}) {
      logger.write(level, { ...fields, component: 'engine' }, message);
    },
  };
}

function parseLogObject(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

// No shell expansion. JSON argv also supports literal quotes inside arguments.
export function parseEngineCommand(value: string): EngineCommand {
  let args: string[];
  if (value.trim().startsWith('[')) {
    args = z.array(z.string()).min(1).parse(JSON.parse(value));
  } else {
    args = [];
    let token = '';
    let quote: string | null = null;
    let started = false;
    for (const char of value.trim()) {
      if (quote) {
        if (char === quote) quote = null;
        else token += char;
      } else if (char === '"' || char === "'") {
        quote = char;
        started = true;
      } else if (/\s/.test(char)) {
        if (started) {
          args.push(token);
          token = '';
          started = false;
        }
      } else {
        token += char;
        started = true;
      }
    }
    if (quote)
      throw new Error('CYBERSOC_ENGINE_CMD contiene comillas sin cerrar.');
    if (started) args.push(token);
  }
  const file = args.shift();
  if (!file) throw new Error('CYBERSOC_ENGINE_CMD requiere un ejecutable.');
  return { file, args };
}

interface Run {
  child: ChildProcessWithoutNullStreams;
  client: JsonRpcEngineClient;
  exited: Promise<void>;
  hasExited: boolean;
  stopping: Promise<void> | null;
}

export class EngineProcess {
  private state: EngineState = {
    status: 'disconnected',
    engineVersion: null,
    protocol: null,
  };
  private run: Run | null = null;
  private connecting: Promise<EngineState> | null = null;
  private closing = false;

  constructor(
    private readonly options: {
      command: () => EngineCommand;
      cwd: string;
      logger: EngineLogger;
      spawnProcess?: typeof spawn;
    },
  ) {}

  getState(): EngineState {
    return { ...this.state };
  }

  reconnect(): Promise<EngineState> {
    if (this.closing)
      return Promise.reject(new Error('La aplicacion se esta cerrando.'));
    if (this.connecting) return this.connecting;
    this.connecting = this.start().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  ping(): Promise<{ ts: string }> {
    if (!this.run || this.state.status !== 'connected')
      return Promise.reject(new Error('Motor desconectado.'));
    return this.run.client.ping();
  }

  scanFile(params: ScanFileParams, timeoutMs: number): Promise<EngineResult> {
    if (!this.run || this.state.status !== 'connected')
      return Promise.reject(new Error('Motor desconectado.'));
    return this.run.client.scanFile(params, timeoutMs);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.run) await this.stop(this.run);
    await this.connecting;
    this.disconnected();
  }

  private disconnected(): void {
    this.state = {
      status: 'disconnected',
      engineVersion: null,
      protocol: null,
    };
  }

  private async start(): Promise<EngineState> {
    if (this.run) await this.stop(this.run);
    this.disconnected();
    if (this.closing) return this.getState();
    let run: Run | undefined;
    try {
      const command = this.options.command();
      const child = (this.options.spawnProcess ?? spawn)(
        command.file,
        command.args,
        {
          cwd: this.options.cwd,
          windowsHide: true,
          shell: false,
          stdio: 'pipe',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const client = new JsonRpcEngineClient(
        { input: child.stdin, output: child.stdout, lifecycle: child },
        {
          onDisconnect: () => {
            if (this.run?.child !== child) return;
            this.disconnected();
            if (!this.run.stopping && !this.run.hasExited) child.kill();
          },
        },
      );
      run = { child, client, exited, hasExited: false, stopping: null };
      this.run = run;
      const current = run;
      const stderr = createInterface({
        input: child.stderr,
        crlfDelay: Infinity,
      });
      stderr.on('line', (line) => this.recordStderrLine(line));
      child.stderr.on('error', (error) =>
        this.record('error', error.message, { component: 'engine' }),
      );
      const finish = () => {
        current.hasExited = true;
        client.dispose();
        if (this.run === current) this.disconnected();
        resolveExit();
      };
      child.once('exit', finish);
      child.once('error', (error) => {
        this.record('error', error.message, { component: 'engine' });
        if (child.pid === undefined) finish();
      });
      child.once('close', () => stderr.close());
      const info = await client.hello();
      if (!this.closing && !run.hasExited && this.run === run) {
        this.state = {
          status: 'connected',
          engineVersion: info.engineVersion,
          protocol: info.protocol,
        };
      }
    } catch (error) {
      this.record(
        'error',
        error instanceof Error ? error.message : 'Error del motor.',
        { component: 'engine' },
      );
      if (run) await this.stop(run);
      if (
        !this.closing &&
        (error instanceof IncompatibleEngineError ||
          (error instanceof RpcRemoteError && error.code === -32602))
      ) {
        this.state = {
          status: 'incompatible',
          engineVersion:
            error instanceof IncompatibleEngineError
              ? error.engineVersion
              : null,
          protocol:
            error instanceof IncompatibleEngineError ? error.protocol : null,
        };
      }
    }
    return this.getState();
  }

  private record(
    level: string,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    if (this.options.logger.log) {
      this.options.logger.log(level, message, fields);
      return;
    }
    const normalized = level.toLowerCase();
    if (
      normalized === 'error' ||
      normalized === 'fatal' ||
      normalized === 'critical'
    ) {
      this.options.logger.error(message, fields);
      return;
    }
    this.options.logger.info(message, fields);
  }

  private recordStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseLogObject(trimmed);
    if (!parsed) {
      this.record('info', trimmed, { component: 'engine' });
      return;
    }
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.msg === 'string'
          ? parsed.msg
          : trimmed;
    this.record(
      typeof parsed.level === 'string' ? parsed.level : 'info',
      message,
      { ...parsed, component: 'engine' },
    );
  }

  private stop(run: Run): Promise<void> {
    if (run.stopping) return run.stopping;
    run.stopping = (async () => {
      if (!run.hasExited) {
        const timer = setTimeout(() => {
          if (!run.hasExited) run.child.kill('SIGKILL');
        }, 2_000);
        try {
          void run.client.shutdown().catch(() => {});
          await run.exited;
        } finally {
          clearTimeout(timer);
        }
      }
      run.client.dispose();
      if (this.run === run) {
        this.run = null;
        this.disconnected();
      }
    })();
    return run.stopping;
  }
}

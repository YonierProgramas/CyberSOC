import { join } from 'node:path';
import pino, { type Logger as PinoLogger } from 'pino';

const REDACTED = '[Redacted]';
const SECRET_KEYS = new Set(['apikey', 'authorization', 'x-api-key']);
const FILE_CONTENT_KEYS = new Set([
  'content',
  'contents',
  'filecontent',
  'filecontents',
  'file_content',
]);

export interface LogFields {
  component: string;
  [key: string]: unknown;
}

export interface AppLogger {
  write(level: string, fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  filePath(date?: Date): string;
  flush(): void;
}

export function logFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `cybersoc-${date.getFullYear()}-${month}-${day}.jsonl`;
}

function scrubSensitiveString(value: string): string {
  return value.replace(
    /(["']?)(fileContents|fileContent|file_content|x-api-key|authorization|contents|content|apiKey)\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+\S+|\S+)/gi,
    '$1$2$1$3[Redacted]',
  );
}

function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSensitiveString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    output[key] =
      SECRET_KEYS.has(normalized) || FILE_CONTENT_KEYS.has(normalized)
        ? REDACTED
        : redactLogValue(child, seen);
  }
  return output;
}

function finalize(value: unknown): Record<string, unknown> {
  const source =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const redacted = redactLogValue(source) as Record<string, unknown>;
  return {
    ...redacted,
    ts:
      typeof redacted.ts === 'string' ? redacted.ts : new Date().toISOString(),
    level: typeof redacted.level === 'string' ? redacted.level : 'info',
    component:
      typeof redacted.component === 'string' ? redacted.component : 'core',
    msg:
      typeof redacted.msg === 'string'
        ? scrubSensitiveString(redacted.msg)
        : '',
  };
}

function normalizeLine(line: string): string {
  try {
    return `${JSON.stringify(finalize(JSON.parse(line)))}\n`;
  } catch {
    return `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'core',
      msg: 'Entrada de log descartada',
    })}\n`;
  }
}

const loggerOptions: pino.LoggerOptions = {
  base: null,
  messageKey: 'msg',
  timestamp: () => `,"ts":${JSON.stringify(new Date().toISOString())}`,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  hooks: {
    streamWrite: normalizeLine,
  },
};

function pinoLevel(
  level: string,
): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
  switch (level.toLowerCase()) {
    case 'trace':
      return 'trace';
    case 'debug':
      return 'debug';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    case 'fatal':
    case 'critical':
      return 'fatal';
    default:
      return 'info';
  }
}

class FileLogger implements AppLogger {
  private destination: ReturnType<typeof pino.destination> | null = null;
  private logger: PinoLogger | null = null;
  private openPath: string | null = null;

  constructor(private readonly directory: string) {}

  filePath(date = new Date()): string {
    return join(this.directory, logFileName(date));
  }

  info(fields: LogFields, message: string): void {
    this.write('info', fields, message);
  }

  warn(fields: LogFields, message: string): void {
    this.write('warn', fields, message);
  }

  error(fields: LogFields, message: string): void {
    this.write('error', fields, message);
  }

  write(level: string, fields: LogFields, message: string): void {
    const logger = this.active();
    logger[pinoLevel(level)](fields, scrubSensitiveString(message));
  }

  flush(): void {
    this.destination?.flushSync();
  }

  private active(): PinoLogger {
    const path = this.filePath();
    if (this.logger && this.openPath === path) return this.logger;
    this.destination?.flushSync();
    this.destination?.end();
    this.openPath = path;
    this.destination = pino.destination({
      dest: path,
      mkdir: true,
      sync: true,
    });
    this.logger = pino(loggerOptions, this.destination);
    return this.logger;
  }
}

export function createLogger(logsDirectory: string): AppLogger {
  return new FileLogger(logsDirectory);
}

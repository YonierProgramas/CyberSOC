import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  appConfigSchema,
  type AppConfig,
} from '../../src/core/config/AppConfig';
import { EngineProcess } from '../../src/core/engine/EngineProcess';
import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import {
  ScanJobRepository,
  type ScanJobRecord,
} from '../../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../../src/core/persistence/ScanResultRepository';
import { ScanOrchestrator } from '../../src/core/scan/ScanOrchestrator';

export function pythonExecutable(engineRoot: string): string {
  const python = join(
    engineRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (!existsSync(python))
    throw new Error(
      `Falta el entorno Python: ${python}. Ejecuta uv sync en engine/.`,
    );
  return python;
}

export function realRuntime(
  engineRoot: string,
  databasePath: string,
  config: AppConfig = appConfigSchema.parse({}),
) {
  const python = pythonExecutable(engineRoot);
  const logs: string[] = [];
  const record = (message: string) => {
    logs.push(message);
    if (logs.length > 30) logs.shift();
  };
  // Resolve the package in THIS checkout, even if .venv is shared with another worktree.
  const spawnProcess = ((
    file: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) =>
    spawn(file, args, {
      ...options,
      env: { ...options?.env, PYTHONPATH: join(engineRoot, 'src') },
    })) as typeof spawn;
  const engine = new EngineProcess({
    command: () => ({ file: python, args: ['-m', 'cybersoc_engine'] }),
    cwd: engineRoot,
    logger: { info: record, error: record },
    spawnProcess,
  });
  const database = new Database(databasePath);
  new MigrationRunner(database).run();
  const jobs = new ScanJobRepository(database);
  const results = new ScanResultRepository(database);
  const orchestrator = new ScanOrchestrator({
    config: () => config,
    engine,
    jobs,
    results,
    onError: (error) => record(String(error)),
  });
  let active: string | null = null;

  async function connect(): Promise<void> {
    const state = await engine.reconnect();
    if (state.status !== 'connected')
      throw new Error(`No conectó el motor real: ${logs.join('\n')}`);
  }

  function scan(path: string, deadlineMs = 60_000): Promise<ScanJobRecord> {
    return new Promise((resolve, reject) => {
      let id: string;
      const finish = (job: ScanJobRecord) => {
        if (job.id !== id) return;
        clearTimeout(timer);
        orchestrator.off('finished', finish);
        active = null;
        resolve(job);
      };
      const timer = setTimeout(() => {
        orchestrator.off('finished', finish);
        reject(
          new Error(
            `El escaneo real superó ${deadlineMs} ms. ${logs.join('\n')}`,
          ),
        );
      }, deadlineMs);
      orchestrator.on('finished', finish);
      try {
        id = orchestrator.start({ kind: 'FOLDER', path });
        active = id;
      } catch (error) {
        clearTimeout(timer);
        orchestrator.off('finished', finish);
        reject(error);
      }
    });
  }

  async function close(): Promise<void> {
    try {
      if (active !== null) await orchestrator.cancel(active);
    } finally {
      try {
        await engine.close();
      } finally {
        database.close();
      }
    }
  }
  return {
    engine,
    database,
    jobs,
    results,
    orchestrator,
    logs,
    connect,
    scan,
    close,
  };
}

export async function generatedFixtures(
  engineRoot: string,
  hostPath: string,
): Promise<{ root: string; close: () => Promise<void> }> {
  const generator = join(engineRoot, 'tests', 'fixtures', 'generate.py');
  if (!existsSync(generator))
    throw new Error(`Falta el generador de T1.2: ${generator}`);
  const child = spawn(
    pythonExecutable(engineRoot),
    ['-B', '-X', 'utf8', hostPath, generator],
    {
      cwd: engineRoot,
      windowsHide: true,
      shell: false,
      stdio: 'pipe',
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  // Attach a rejection handler immediately while waiting for the first protocol line.
  void exited.catch(() => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    const root = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timeout al generar fixtures.')),
        10_000,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', () =>
        fail(
          new Error(
            `El generador terminó antes de entregar su carpeta: ${stderr}`,
          ),
        ),
      );
      lines.once('line', (line) => {
        clearTimeout(timer);
        try {
          const value: unknown = JSON.parse(line);
          if (
            !value ||
            typeof value !== 'object' ||
            !('root' in value) ||
            typeof value.root !== 'string'
          )
            throw new Error('Respuesta de fixtures inválida.');
          resolve(value.root);
        } catch (error) {
          reject(error);
        }
      });
    });
    return { root, close: () => closeHost(child, exited, lines, () => stderr) };
  } catch (error) {
    await closeHost(child, exited, lines, () => stderr);
    throw error;
  }
}

async function closeHost(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<number | null>,
  lines: ReturnType<typeof createInterface>,
  stderr: () => string,
): Promise<void> {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    if ((await exited) !== 0)
      throw new Error(`Falló la limpieza del generador: ${stderr()}`);
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

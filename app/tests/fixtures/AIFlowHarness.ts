import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import { ScanResultRepository } from '../../src/core/persistence/ScanResultRepository';
import type { ScanJobRecord } from '../../src/core/persistence/ScanJobRepository';
import { EngineProcess } from '../../src/core/engine/EngineProcess';
import type { AIProvider } from '../../src/core/ai/AIProvider';
import {
  createAIWorkflow,
  createScanOrchestrator,
} from '../../src/main/composition-root';

const appRoot = resolve(import.meta.dirname, '../..');
const engineRoot = resolve(appRoot, '../engine');
const python = join(
  engineRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

function pythonEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {
    ...env,
    PYTHONPATH: join(engineRoot, 'src'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  delete filtered.CYBERSOC_ANTHROPIC_API_KEY;
  return filtered;
}

/** Motor real, SQLite temporal y proveedor intercambiable; nunca escanea archivos del usuario. */
export class AIFlowHarness {
  readonly root = mkdtempSync(join(tmpdir(), 'cybersoc-ai-flows-'));
  readonly fixtures = join(this.root, 'fixtures');
  readonly signature = join(this.fixtures, 'CSD-TEST-001.txt');
  readonly clean = join(this.fixtures, 'clean.txt');
  readonly lowScore = join(this.root, 'factura.pdf.exe');
  readonly suspicious = join(this.fixtures, 'factura\u202e.pdf.exe');
  db = new Database(join(this.root, 'test.db'));
  worker;
  readonly engine = new EngineProcess({
    command: () => ({ file: python, args: ['-m', 'cybersoc_engine'] }),
    cwd: appRoot,
    logger: { info() {}, error() {} },
    spawnProcess: ((
      file: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) =>
      spawn(file, args, {
        ...options,
        env: pythonEnvironment(options?.env ?? process.env),
        windowsHide: true,
      })) as typeof spawn,
  });

  constructor(private readonly provider: () => AIProvider | null) {
    new MigrationRunner(this.db).run();
    this.worker = createAIWorkflow(this.db, provider);
  }

  async prepare(): Promise<void> {
    mkdirSync(this.fixtures);
    // Reutiliza el generador de T2.3: cinco textos deterministas, nunca EICAR.
    execFileSync(
      python,
      [
        '-c',
        'import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1])["generate_signature_fixtures"](Path(sys.argv[2]))',
        join(engineRoot, 'tests/fixtures/generate.py'),
        this.fixtures,
      ],
      {
        env: pythonEnvironment(process.env),
        windowsHide: true,
        timeout: 15_000,
        stdio: 'pipe',
      },
    );
    writeFileSync(
      this.clean,
      'Documento limpio para las pruebas de integración.\n',
    );
    // Una sola heurística suma 25: CLEAN con evidencia, sin contenido ejecutable.
    writeFileSync(this.lowScore, 'Texto inofensivo con doble extensión.\n');
    writeFileSync(
      this.suspicious,
      'Texto inofensivo con doble extensión y RLO en el nombre.\n',
    );
    const state = await this.engine.reconnect();
    if (state.status !== 'connected')
      throw new Error('No se conectó el motor Python de pruebas.');
  }

  async scan(path = this.fixtures) {
    const scan = createScanOrchestrator(this.db, this.engine, this.worker);
    const done = new Promise<ScanJobRecord>((resolve) =>
      scan.once('finished', resolve),
    );
    const jobId = scan.start({
      kind: path === this.fixtures ? 'FOLDER' : 'FILE',
      path,
    });
    const job = await done;
    return {
      job,
      results: new ScanResultRepository(this.db).listByJob(jobId, 0, 100),
    };
  }

  async restart(): Promise<void> {
    await this.worker.stop();
    this.db.close();
    this.db = new Database(join(this.root, 'test.db'));
    this.worker = createAIWorkflow(this.db, this.provider);
    this.worker.start();
  }

  async close(): Promise<void> {
    await this.worker.stop();
    await this.engine.close();
    this.db.close();
    // Solo la carpeta creada por mkdtemp para esta prueba.
    rmSync(this.root, { recursive: true, force: true });
  }
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { engineResultSchema } from '../src/shared/protocol';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';
import { ScanOrchestrator } from '../src/core/scan/ScanOrchestrator';

it('AUD-02: error real Python cruza contrato y persiste ERROR, nunca CLEAN', async () => {
  const python = resolve(
    '../engine/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const env = { ...process.env };
  delete env.PYTHONPATH;
  const wire = JSON.parse(
    execFileSync(python, [resolve('tests/integration/changing-file-host.py')], {
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    }),
  );
  const changed = engineResultSchema.parse(wire);
  expect(changed).toMatchObject({
    status: 'ERROR',
    verdict: 'ERROR',
    error: { code: 'IO_ERROR' },
    score: null,
  });
  expect(changed.hashes).toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), 'cybersoc-changed-policy-'));
  const db = new Database(join(root, 'test.db'));
  try {
    new MigrationRunner(db).run();
    const file = join(root, 'benigno.txt');
    writeFileSync(file, 'hola\n');
    const jobs = new ScanJobRepository(db);
    const results = new ScanResultRepository(db);
    const orchestrator = new ScanOrchestrator({
      config: () => appConfigSchema.parse({}),
      jobs,
      results,
      engine: {
        getState: () => ({
          status: 'connected',
          engineVersion: '0.0.1',
          protocol: '1',
        }),
        reconnect: async () => ({
          status: 'connected',
          engineVersion: '0.0.1',
          protocol: '1',
        }),
        scanFile: async (params) => ({ ...changed, taskId: params.taskId }),
      },
    });
    const done = new Promise<void>((resolveDone) =>
      orchestrator.once('finished', () => resolveDone()),
    );
    const id = orchestrator.start({ kind: 'FILE', path: file });
    await done;
    expect(jobs.get(id)?.filesError).toBe(1);
    const stored = db
      .prepare(
        'SELECT status, verdict, engine_score FROM scan_results WHERE job_id=?',
      )
      .all(id);
    // El contrato SQLite conserva NOT_EVALUATED para el error técnico; nunca CLEAN.
    expect(stored).toEqual([
      { status: 'ERROR', verdict: 'NOT_EVALUATED', engine_score: null },
    ]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

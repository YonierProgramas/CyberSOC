import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import {
  ScanJobRepository,
  type ScanJobCounters,
  type ScanJobStatus,
} from '../src/core/persistence/ScanJobRepository';
import {
  ScanResultRepository,
  type InsertScanResult,
} from '../src/core/persistence/ScanResultRepository';

const createdAt = '2026-09-30T12:00:00.000Z';
const counters: ScanJobCounters = {
  filesDiscovered: 5,
  filesProcessed: 4,
  filesError: 1,
  filesSkipped: 1,
  bytesProcessed: 300,
};

describe('Migración 002 y repositorios sobre SQLite temporal', () => {
  let directory: string;
  let database: Database;
  let jobs: ScanJobRepository;
  let results: ScanResultRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-scan-repos-'));
    database = new Database(join(directory, 'cybersoc.db'));
    new MigrationRunner(database, [initialMigration]).run();
  });

  afterEach(() => {
    database.close();
    // Only the temporary directory allocated by this test is removed.
    rmSync(directory, { recursive: true, force: true });
  });

  function migrate(): void {
    new MigrationRunner(database).run();
    jobs = new ScanJobRepository(database);
    results = new ScanResultRepository(database);
  }

  function createJob(id = 'job-1', date = createdAt) {
    return jobs.create({
      id,
      targetPath: 'C:\\Documentos\\niño áéíóú 😀',
      targetKind: 'FOLDER',
      createdAt: date,
    });
  }

  function resultInput(seq: number, jobId = 'job-1'): InsertScanResult {
    return {
      id: `${jobId}-${seq}`,
      jobId,
      seq,
      path: `C:\\Documentos\\niño áéíóú 😀\\informe-${seq}.txt`,
      fileName: `informe-${seq}.txt`,
      extension: '.txt',
      sizeBytes: 3,
      modifiedAt: createdAt,
      status: 'SCANNED',
      sha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      durationMs: 1,
      scannedAt: createdAt,
    };
  }

  it('actualiza una BD v1, conserva sus datos y no reaplica 002 al reabrir', () => {
    const historyV1 = database.prepare('SELECT * FROM schema_migrations').all();
    database
      .prepare('INSERT INTO settings VALUES (?, ?, ?)')
      .run('tema', '"oscuro"', createdAt);
    expect(
      new MigrationRunner(database, [initialMigration, scansMigration]).run(),
    ).toEqual([2]);
    const historyV2 = database
      .prepare('SELECT * FROM schema_migrations ORDER BY version')
      .all();
    expect(historyV2).toEqual([
      ...historyV1,
      { version: 2, name: '002_scans', applied_at: expect.any(String) },
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_results_%' ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'idx_results_job' }, { name: 'idx_results_sha256' }]);
    database.close();
    database = new Database(database.path);
    expect(
      new MigrationRunner(database, [initialMigration, scansMigration]).run(),
    ).toEqual([]);
    expect(
      database
        .prepare('SELECT * FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual(historyV2);
    expect(database.prepare('SELECT * FROM settings').all()).toEqual([
      { key: 'tema', value_json: '"oscuro"', updated_at: createdAt },
    ]);
  });

  it('revierte el DDL parcial de 002 y mantiene v1 si hay un conflicto de tablas', () => {
    database.exec('CREATE TABLE scan_results (legacy TEXT)');
    expect(() => new MigrationRunner(database).run()).toThrow('already exists');
    expect(
      database.prepare('SELECT version FROM schema_migrations').all(),
    ).toEqual([{ version: 1 }]);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'scan_jobs'")
        .get(),
    ).toBeUndefined();
    expect(
      database.prepare('PRAGMA table_info(scan_results)').all(),
    ).toMatchObject([{ name: 'legacy' }]);
  });

  it('crea un trabajo con valores iniciales y conserva rutas Unicode y texto SQL literalmente', () => {
    migrate();
    const job = createJob();
    expect(job).toEqual({
      id: 'job-1',
      targetPath: 'C:\\Documentos\\niño áéíóú 😀',
      targetKind: 'FOLDER',
      status: 'CREATED',
      filesDiscovered: 0,
      filesProcessed: 0,
      filesError: 0,
      filesSkipped: 0,
      bytesProcessed: 0,
      engineVersion: null,
      protocolVersion: null,
      metricsJson: null,
      errorMessage: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    });
    const path = "C:\\niño'; DROP TABLE scan_jobs; --.txt";
    const fileJob = jobs.create({
      id: 'file',
      targetPath: path,
      targetKind: 'FILE',
      engineVersion: '0.1.0',
      protocolVersion: '1',
    });
    expect(fileJob).toMatchObject({
      targetPath: path,
      engineVersion: '0.1.0',
      protocolVersion: '1',
    });
    expect(new Date(fileJob.createdAt).toISOString()).toBe(fileJob.createdAt);
    expect(jobs.get('job-1')).toEqual(job);
    expect(jobs.get('missing')).toBeUndefined();
    expect(() => createJob()).toThrow('UNIQUE constraint failed');
    expect(jobs.listRecent()).toHaveLength(2);
  });

  it('actualiza estado y fechas sin borrar campos omitidos y permite limpiar el error', () => {
    migrate();
    createJob();
    jobs.updateStatus('job-1', 'DISCOVERING', { startedAt: createdAt });
    jobs.updateStatus('job-1', 'SCANNING');
    expect(jobs.get('job-1')).toMatchObject({
      status: 'SCANNING',
      startedAt: createdAt,
    });
    jobs.updateStatus('job-1', 'FAILED', {
      finishedAt: createdAt,
      errorMessage: 'Motor desconectado',
    });
    expect(jobs.get('job-1')).toMatchObject({
      status: 'FAILED',
      startedAt: createdAt,
      finishedAt: createdAt,
      errorMessage: 'Motor desconectado',
    });
    jobs.updateStatus('job-1', 'FAILED', { errorMessage: null });
    expect(jobs.get('job-1')).toMatchObject({
      errorMessage: null,
      startedAt: createdAt,
      finishedAt: createdAt,
    });
    expect(() => jobs.updateStatus('missing', 'FAILED')).toThrow(
      'No existe el trabajo',
    );
  });

  it.each<ScanJobStatus>([
    'CREATED',
    'DISCOVERING',
    'SCANNING',
    'CANCELLING',
    'CANCELLED',
    'COMPLETED',
    'FAILED',
  ])('persiste el estado permitido %s', (status) => {
    migrate();
    createJob();
    jobs.updateStatus('job-1', status);
    expect(jobs.get('job-1')?.status).toBe(status);
  });

  it('reemplaza contadores sin duplicarlos y conserva las métricas si se omiten', () => {
    migrate();
    createJob();
    const metricsJson = '{"peakStackSize":3,"peakQueueSize":2}';
    jobs.updateCounters('job-1', { ...counters, metricsJson });
    jobs.updateCounters('job-1', counters);
    expect(jobs.get('job-1')).toMatchObject({ ...counters, metricsJson });
    jobs.updateCounters('job-1', { ...counters, metricsJson: null });
    expect(jobs.get('job-1')?.metricsJson).toBeNull();
    expect(() => jobs.updateCounters('missing', counters)).toThrow(
      'No existe el trabajo',
    );
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza cantidades y paginación inválidas: %s',
    (invalid) => {
      migrate();
      createJob();
      expect(() =>
        jobs.updateCounters('job-1', { ...counters, bytesProcessed: invalid }),
      ).toThrow(RangeError);
      expect(jobs.get('job-1')?.filesProcessed).toBe(0);
      expect(() => jobs.listRecent(invalid)).toThrow(RangeError);
      expect(() => results.listByJob('job-1', invalid, 10)).toThrow(RangeError);
      expect(() => results.listByJob('job-1', 0, invalid)).toThrow(RangeError);
      expect(() => results.insertResult(resultInput(invalid))).toThrow(
        RangeError,
      );
    },
  );

  it('lista trabajos recientes con límite y desempate estable por id', () => {
    migrate();
    createJob('old', '2026-09-29T00:00:00.000Z');
    createJob('a');
    createJob('b');
    expect(jobs.listRecent().map(({ id }) => id)).toEqual(['b', 'a', 'old']);
    expect(jobs.listRecent(1).map(({ id }) => id)).toEqual(['b']);
    expect(jobs.listRecent(0)).toEqual([]);
  });

  it('pagina por secuencia, aísla trabajos y conserva resultados al reabrir', () => {
    migrate();
    createJob();
    createJob('other');
    for (const seq of [3, 0, 4, 1, 2]) results.insertResult(resultInput(seq));
    results.insertResult(resultInput(0, 'other'));
    expect(results.listByJob('job-1', 0, 2).map(({ seq }) => seq)).toEqual([
      0, 1,
    ]);
    expect(results.listByJob('job-1', 2, 2).map(({ seq }) => seq)).toEqual([
      2, 3,
    ]);
    expect(results.listByJob('job-1', 4, 2).map(({ seq }) => seq)).toEqual([4]);
    expect(results.listByJob('job-1', 5, 2)).toEqual([]);
    expect(results.listByJob('job-1', 0, 0)).toEqual([]);
    expect(results.listByJob('missing', 0, 10)).toEqual([]);
    const rows = results.listByJob('job-1', 0, 10);
    expect(rows[0]).toEqual({
      ...resultInput(0),
      verdict: 'NOT_EVALUATED',
      errorCode: null,
      errorMessage: null,
      detectedType: null,
      engineScore: null,
      riskLevel: null,
      aiStatus: 'NOT_REQUIRED',
    });
    database.close();
    database = new Database(database.path);
    migrate();
    expect(results.listByJob('job-1', 0, 10)).toEqual(rows);
    expect(jobs.get('job-1')?.targetKind).toBe('FOLDER');
  });

  it.each([
    ['ERROR', 'ACCESS_DENIED'],
    ['SKIPPED', 'CLOUD_PLACEHOLDER'],
  ] as const)('guarda %s sin hash ni veredicto de IA', (status, errorCode) => {
    migrate();
    createJob();
    const row = results.insertResult({
      id: 'error',
      jobId: 'job-1',
      seq: 0,
      path: 'C:\\privado',
      fileName: 'privado',
      status,
      errorCode,
      errorMessage: 'No se pudo analizar',
    });
    expect(row).toMatchObject({
      status,
      errorCode,
      errorMessage: 'No se pudo analizar',
      sha256: null,
      sizeBytes: null,
      extension: null,
      modifiedAt: null,
      durationMs: null,
      verdict: 'NOT_EVALUATED',
    });
    expect(new Date(row.scannedAt).toISOString()).toBe(row.scannedAt);
  });

  it('los CHECK rechazan estados, tipo de destino, hash y veredicto inválidos', () => {
    migrate();
    createJob();
    expect(() =>
      jobs.updateStatus('job-1', 'INVALID' as ScanJobStatus),
    ).toThrow('CHECK constraint failed');
    expect(jobs.get('job-1')?.status).toBe('CREATED');
    expect(() =>
      database
        .prepare('UPDATE scan_jobs SET target_kind = ? WHERE id = ?')
        .run('INVALID', 'job-1'),
    ).toThrow('CHECK constraint failed');
    expect(() =>
      results.insertResult({
        ...resultInput(0),
        status: 'INVALID' as InsertScanResult['status'],
      }),
    ).toThrow('CHECK constraint failed');
    expect(() =>
      results.insertResult({ ...resultInput(0), sha256: 'short' }),
    ).toThrow('CHECK constraint failed');
    results.insertResult(resultInput(0));
    expect(() =>
      database
        .prepare('UPDATE scan_results SET verdict = ? WHERE id = ?')
        .run('INVALID', 'job-1-0'),
    ).toThrow('CHECK constraint failed');
    expect(results.listByJob('job-1', 0, 10)).toHaveLength(1);
  });

  it('rechaza referencias inexistentes y duplicados sin perder filas válidas', () => {
    migrate();
    createJob();
    expect(() => results.insertResult(resultInput(0, 'missing'))).toThrow(
      'FOREIGN KEY constraint failed',
    );
    const row = results.insertResult(resultInput(0));
    expect(() =>
      results.insertResult({ ...resultInput(0), id: 'duplicate-seq' }),
    ).toThrow('UNIQUE constraint failed');
    expect(() =>
      results.insertResult({ ...resultInput(1), id: row.id }),
    ).toThrow('UNIQUE constraint failed');
    expect(results.listByJob('job-1', 0, 10)).toEqual([row]);
    expect(results.insertResult(resultInput(1)).seq).toBe(1);
  });

  it('revierte una inserción ya ejecutada cuando falla un trigger posterior', () => {
    migrate();
    createJob();
    // RAISE(FAIL) alone retains prior changes; the repository must roll them back.
    database.exec(`CREATE TRIGGER fail_result AFTER INSERT ON scan_results
      WHEN NEW.id = 'fail' BEGIN SELECT RAISE(FAIL, 'forced failure'); END;`);
    expect(() =>
      results.insertResult({ ...resultInput(0), id: 'fail' }),
    ).toThrow('forced failure');
    expect(results.listByJob('job-1', 0, 10)).toEqual([]);
    expect(results.insertResult(resultInput(0)).id).toBe('job-1-0');
  });

  it('borra en cascada solo los resultados del trabajo eliminado', () => {
    migrate();
    createJob();
    createJob('other');
    results.insertResult(resultInput(0));
    results.insertResult(resultInput(1));
    const kept = results.insertResult(resultInput(0, 'other'));
    database.prepare('DELETE FROM scan_jobs WHERE id = ?').run('job-1');
    expect(jobs.get('job-1')).toBeUndefined();
    expect(results.listByJob('job-1', 0, 10)).toEqual([]);
    expect(results.listByJob('other', 0, 10)).toEqual([kept]);
  });
});

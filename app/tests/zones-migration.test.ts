import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../src/core/persistence/migrations/003_evidence_ai';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../src/core/persistence/ScanResultRepository';

describe('Migración 004 y persistencia de zonas', () => {
  const databases: Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });
  function setup() {
    const db = new Database(':memory:');
    databases.push(db);
    new MigrationRunner(db, [
      initialMigration,
      scansMigration,
      evidenceAiMigration,
    ]).run();
    return db;
  }
  it('migra datos históricos sin asignarles versiones o zonas inventadas', () => {
    const db = setup();
    db.exec(`INSERT INTO scan_jobs (id, target_path, target_kind, status, created_at)
      VALUES ('old', 'C:\\Windows', 'FOLDER', 'COMPLETED', '2026-01-01');`);
    expect(new MigrationRunner(db).run()).toEqual([4, 5, 6]);
    expect(new MigrationRunner(db).run()).toEqual([]);
    expect(new ScanJobRepository(db).get('old')).toMatchObject({
      rulesetVersion: null,
      signaturesVersion: null,
      profileJson: null,
    });
    expect(db.prepare("PRAGMA index_info('idx_results_zone')").all()).toEqual([
      expect.objectContaining({ name: 'zone' }),
    ]);
  });
  it('guarda perfil, versiones y zona; revierte la zona junto al resultado completo', () => {
    const db = setup();
    new MigrationRunner(db).run();
    const jobs = new ScanJobRepository(db);
    const results = new ScanResultRepository(db);
    jobs.create({
      id: 'j',
      targetPath: 'C:\\Windows',
      targetKind: 'FOLDER',
      profileJson: '{"mode":"AUTO"}',
    });
    jobs.updateVersions('j', {
      rulesetVersion: 'rules-3',
      signaturesVersion: 'sig-2',
    });
    expect(jobs.get('j')).toMatchObject({
      profileJson: '{"mode":"AUTO"}',
      rulesetVersion: 'rules-3',
      signaturesVersion: 'sig-2',
    });
    expect(() =>
      jobs.updateVersions('absent', {
        rulesetVersion: 'r',
        signaturesVersion: 's',
      }),
    ).toThrow();
    const input = {
      id: 'f',
      jobId: 'j',
      seq: 0,
      path: 'C:\\Windows\\a.txt',
      fileName: 'a.txt',
      status: 'SKIPPED' as const,
      zone: 'SISTEMA' as const,
    };
    expect(
      results.insertComplete({
        result: input,
        evidence: [],
        layers: [],
        assessment: null,
      }).zone,
    ).toBe('SISTEMA');
    expect(() =>
      results.insertComplete({
        result: { ...input, id: 'bad', seq: 1 },
        evidence: [],
        layers: [
          { layer: 'HASH', status: 'DISABLED', hits: 0, points: 0, ms: 0 },
        ],
        assessment: null,
      }),
    ).toThrow();
    expect(results.get('bad')).toBeUndefined();
    expect(results.listByJob('j', 0, 20)).toHaveLength(1);
  });
});

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../src/core/persistence/migrations/003_evidence_ai';
import { zonesMigration } from '../src/core/persistence/migrations/004_zones';
import { quarantineMigration } from '../src/core/persistence/migrations/005_quarantine';
import { conversationsMigration } from '../src/core/persistence/migrations/006_conversations';
import { openDatabaseWithBackup } from '../src/core/persistence/UpgradeBackup';
import { seedHistory, seedMessages } from './fixtures/history';

const migrations006 = [
  initialMigration,
  scansMigration,
  evidenceAiMigration,
  zonesMigration,
  quarantineMigration,
  conversationsMigration,
];
const profile = () =>
  mkdtempSync(join(tmpdir(), 'cybersoc-upgrade-á con espacios-'));
function create006(path: string) {
  const db = new Database(join(path, 'cybersoc.db'));
  new MigrationRunner(db, migrations006).run();
  db.prepare('INSERT INTO settings VALUES (?,?,?)').run(
    'synthetic-secret',
    '{"encrypted":"fixture-only"}',
    '2026-11-05',
  );
  return db;
}

it('clean/restart: 001–007 once and no backup of a nonexistent database', () => {
  const root = profile();
  openDatabaseWithBackup(root, '0.11.0').close();
  const db = openDatabaseWithBackup(root, '0.11.0');
  expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()!.n).toBe(
    7,
  );
  expect(readdirSync(root)).not.toContain('backups');
  db.close();
});

it('006 with committed WAL: openable copy before 007, keeps data and restarts without duplication', () => {
  const root = profile();
  const writer = create006(root); // Open connection: the latest rows are in the WAL.
  writer
    .prepare('INSERT INTO settings VALUES (?,?,?)')
    .run('wal-fixture', '42', '2026-11-05');
  const db = openDatabaseWithBackup(root, '0.11.0');
  const backups = readdirSync(join(root, 'backups'));
  expect(backups).toHaveLength(1);
  const directory = join(root, 'backups', backups[0]!);
  const copy = new DatabaseSync(join(directory, 'cybersoc.db'), {
    readOnly: true,
  });
  expect(
    copy.prepare('SELECT MAX(version) v FROM schema_migrations').get()!.v,
  ).toBe(6);
  expect(
    copy
      .prepare("SELECT value_json FROM settings WHERE key='wal-fixture'")
      .get()!.value_json,
  ).toBe('42');
  expect(copy.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe(
    'ok',
  );
  expect(
    JSON.parse(readFileSync(join(directory, 'verified.json'), 'utf8'))
      .schemaVersion,
  ).toBe(6);
  copy.close();
  writer.close();
  db.close();
  const again = openDatabaseWithBackup(root, '0.11.0');
  expect(
    again.prepare('SELECT COUNT(*) n FROM schema_migrations').get()!.n,
  ).toBe(7);
  expect(
    again
      .prepare(
        "SELECT COUNT(*) n FROM settings WHERE key IN ('wal-fixture','synthetic-secret')",
      )
      .get()!.n,
  ).toBe(2);
  expect(readdirSync(join(root, 'backups'))).toEqual(backups);
  again.close();
});

it('failed backup: does not apply 007 or lose rows', () => {
  const root = profile();
  create006(root).close();
  writeFileSync(join(root, 'backups'), 'archivo bloquea directorio');
  expect(() => openDatabaseWithBackup(root, '0.11.0')).toThrow();
  const db = new DatabaseSync(join(root, 'cybersoc.db'));
  expect(
    db.prepare('SELECT MAX(version) v FROM schema_migrations').get()!.v,
  ).toBe(6);
  expect(
    db
      .prepare("SELECT COUNT(*) n FROM settings WHERE key='synthetic-secret'")
      .get()!.n,
  ).toBe(1);
  db.close();
});

it('concurrent writer: fails closed before copy/migration', () => {
  const root = profile();
  const writer = create006(root);
  writer.exec('BEGIN IMMEDIATE');
  try {
    expect(() => openDatabaseWithBackup(root, '0.11.0')).toThrow();
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
  const db = new DatabaseSync(join(root, 'cybersoc.db'));
  expect(
    db.prepare('SELECT MAX(version) v FROM schema_migrations').get()!.v,
  ).toBe(6);
  db.close();
});

it('failed migration: 007 rollback and verified recoverable copy with a compatible version', () => {
  const root = profile();
  const original = create006(root);
  original.exec(
    "CREATE TRIGGER fail007 BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END",
  );
  original.close();
  expect(() => openDatabaseWithBackup(root, '0.11.0')).toThrow(
    'fixture migration failure',
  );
  const db = new DatabaseSync(join(root, 'cybersoc.db'));
  expect(
    db.prepare('SELECT MAX(version) v FROM schema_migrations').get()!.v,
  ).toBe(6);
  expect(
    db
      .prepare("SELECT COUNT(*) n FROM settings WHERE key='synthetic-secret'")
      .get()!.n,
  ).toBe(1);
  db.close();
  expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
});

it('preexisting 007: backs up cards when adopting the version; rejects a future version and moved profile', () => {
  const root = profile();
  const initial = new Database(join(root, 'cybersoc.db'));
  new MigrationRunner(initial).run();
  seedHistory(initial, 3, 12);
  seedMessages(initial, 12);
  initial.close();
  const upgraded = openDatabaseWithBackup(root, '0.11.0');
  expect(upgraded.prepare('SELECT COUNT(*) n FROM scan_jobs').get()!.n).toBe(3);
  expect(upgraded.prepare('SELECT COUNT(*) n FROM scan_results').get()!.n).toBe(
    12,
  );
  expect(upgraded.prepare('SELECT COUNT(*) n FROM ai_messages').get()!.n).toBe(
    12,
  );
  expect(
    upgraded.prepare('SELECT COUNT(*) n FROM ai_message_cards').get()!.n,
  ).toBe(4);
  upgraded.close();
  openDatabaseWithBackup(root, '0.11.0').close();
  expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  expect(() => openDatabaseWithBackup(root, '0.10.0')).toThrow('más reciente');
  const marker = JSON.parse(
    readFileSync(join(root, 'distribution-profile.json'), 'utf8'),
  );
  marker.profileId = 'otro-perfil';
  writeFileSync(
    join(root, 'distribution-profile.json'),
    JSON.stringify(marker),
  );
  expect(() => openDatabaseWithBackup(root, '0.11.0')).toThrow(
    'Perfil incompatible',
  );
  mkdirSync(join(root, 'vault-fixture')); // The test never deletes vaults or secrets.
});

it('invalid FKs: does not certify a copy or continue the migration', () => {
  const root = profile();
  const initial = create006(root);
  initial.exec(
    "PRAGMA foreign_keys=OFF; INSERT INTO scan_results(id,job_id,seq,path,file_name,status,scanned_at) VALUES('orphan','missing',1,'fixture','fixture','SCANNED','2026-11-05')",
  );
  initial.close();
  expect(() => openDatabaseWithBackup(root, '0.11.0')).toThrow('integridad/FK');
  const db = new DatabaseSync(join(root, 'cybersoc.db'));
  expect(
    db.prepare('SELECT MAX(version) v FROM schema_migrations').get()!.v,
  ).toBe(6);
  db.close();
});

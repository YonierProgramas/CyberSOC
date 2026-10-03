import { afterEach, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../src/core/persistence/migrations/003_evidence_ai';
import { zonesMigration } from '../src/core/persistence/migrations/004_zones';
import { AllowlistRepository } from '../src/core/persistence/AllowlistRepository';
import { AuditLog } from '../src/core/persistence/AuditLog';
import { decideRisk } from '../src/core/risk/RiskPolicy';

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
}
it('005 migra desde 004 sin alterar datos y conserva restricciones del plan', () => {
  const db = setup();
  new MigrationRunner(db, [
    initialMigration,
    scansMigration,
    evidenceAiMigration,
    zonesMigration,
  ]).run();
  db.prepare('INSERT INTO settings VALUES (?,?,?)').run(
    'historical',
    '{}',
    'unchanged',
  );
  expect(new MigrationRunner(db).run()).toEqual([5, 6]);
  expect(new MigrationRunner(db).run()).toEqual([]);
  expect(
    db
      .prepare('SELECT value_json,updated_at FROM settings WHERE key=?')
      .get('historical'),
  ).toEqual({ value_json: '{}', updated_at: 'unchanged' });
  expect(
    db
      .prepare('PRAGMA table_info(quarantine_items)')
      .all()
      .map((row) => row.name),
  ).toEqual([
    'id',
    'result_id',
    'original_path',
    'sha256',
    'size_bytes',
    'vault_file',
    'key_b64',
    'iv_b64',
    'auth_tag_b64',
    'reason',
    'verdict_snapshot',
    'status',
    'quarantined_at',
    'restored_at',
    'restored_to',
    'deleted_at',
    'error_message',
  ]);
  expect(db.prepare('PRAGMA foreign_key_list(quarantine_items)').all()).toEqual(
    [
      expect.objectContaining({
        table: 'scan_results',
        from: 'result_id',
        to: 'id',
        on_delete: 'SET NULL',
      }),
    ],
  );
  expect(() =>
    db.exec(
      "INSERT INTO audit_log (id,ts,actor,action) VALUES ('bad','now','UNTRUSTED','DELETE')",
    ),
  ).toThrow();
  expect(() =>
    db.exec(`INSERT INTO quarantine_items (id,original_path,sha256,size_bytes,vault_file,
    key_b64,iv_b64,reason,verdict_snapshot,status) VALUES ('bad','x','x',1,'x','x','x','x','DETECTED','UNKNOWN')`),
  ).toThrow();
});
it('allowlist valida y normaliza SHA-256; auditoría forma parte de la transacción', () => {
  const db = setup();
  new MigrationRunner(db).run();
  const list = new AllowlistRepository(db),
    audit = new AuditLog(db),
    hash = 'AB'.repeat(32);
  expect(() => list.add('not-a-hash', 'reason')).toThrow();
  expect(() =>
    db.transaction(() => {
      list.add(hash, 'test');
      audit.append('ALLOWLIST_ADD', 'id', { sha256: hash });
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(list.list()).toEqual([]);
  expect(audit.list()).toEqual([]);
  list.add(hash, 'confirmado');
  list.add(hash.toLowerCase(), 'nuevo motivo');
  expect(list.has(hash)).toBe(true);
  expect(list.list()).toHaveLength(1);
  expect(list.has(null)).toBe(false);
  expect(list.has('invalid')).toBe(false);
});
it.each(['CLEAN', 'SUSPICIOUS', 'DETECTED'] as const)(
  'allowlist precede al motor %s y a la IA',
  (verdict) => {
    const decision = decideRisk(
      { verdict, score: 100, userAllowlisted: true },
      {
        validationStatus: 'VALID',
        opinion: 'LIKELY_MALICIOUS',
        confidence: 1,
        citedEvidenceIds: ['invented'],
      },
    );
    expect(decision).toMatchObject({
      engineVerdict: verdict,
      engineScore: 100,
      finalVerdict: 'CLEAN',
      finalLevel: 'BAJO',
      origin: 'USER_ALLOWLIST',
      policyVersion: '3',
      aiPending: false,
    });
  },
);
it('sin confianza explícita no baja un DETECTED', () => {
  expect(
    decideRisk({ verdict: 'DETECTED', score: 100, userAllowlisted: false })
      .finalVerdict,
  ).toBe('DETECTED');
});

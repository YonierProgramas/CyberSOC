import type { Migration } from '../MigrationRunner';

export const quarantineMigration: Migration = {
  version: 5,
  name: '005_quarantine',
  up(database) {
    database.exec(`
CREATE TABLE quarantine_items (
  id TEXT PRIMARY KEY,
  result_id TEXT REFERENCES scan_results(id) ON DELETE SET NULL,
  original_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  vault_file TEXT NOT NULL,
  key_b64 TEXT NOT NULL, iv_b64 TEXT NOT NULL, auth_tag_b64 TEXT,
  reason TEXT NOT NULL,
  verdict_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','QUARANTINED','RESTORED','DELETED','FAILED')),
  quarantined_at TEXT, restored_at TEXT, restored_to TEXT, deleted_at TEXT,
  error_message TEXT
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('USER','SYSTEM','AI')),
  action TEXT NOT NULL,        -- QUARANTINE | QUARANTINE_FAILED | RESTORE | DELETE | ALLOWLIST_ADD | SETTINGS_CHANGE
  target_type TEXT, target_id TEXT, details_json TEXT
);
CREATE TABLE allowlist (
  sha256 TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL
);
`);
  },
};

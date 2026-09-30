import type { Migration } from '../MigrationRunner';

export const scansMigration: Migration = {
  version: 2,
  name: '002_scans',
  up(database) {
    database.exec(`
CREATE TABLE scan_jobs (
  id TEXT PRIMARY KEY,
  target_path TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('FILE','FOLDER')),
  status TEXT NOT NULL CHECK (status IN ('CREATED','DISCOVERING','SCANNING','CANCELLING','CANCELLED','COMPLETED','FAILED')),
  files_discovered INTEGER NOT NULL DEFAULT 0,
  files_processed  INTEGER NOT NULL DEFAULT 0,
  files_error      INTEGER NOT NULL DEFAULT 0,
  files_skipped    INTEGER NOT NULL DEFAULT 0,
  bytes_processed  INTEGER NOT NULL DEFAULT 0,
  engine_version TEXT,
  protocol_version TEXT,
  metrics_json TEXT,            -- pico de pila y cola, tiempo bloqueado del productor, duración por fase
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE scan_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT,
  size_bytes INTEGER,
  modified_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('SCANNED','ERROR','SKIPPED')),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  verdict TEXT NOT NULL DEFAULT 'NOT_EVALUATED'
    CHECK (verdict IN ('NOT_EVALUATED','CLEAN','SUSPICIOUS','DETECTED','NOT_ANALYZED')),
  error_code TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  scanned_at TEXT NOT NULL,
  UNIQUE (job_id, seq)
);
CREATE INDEX idx_results_job    ON scan_results(job_id);
CREATE INDEX idx_results_sha256 ON scan_results(sha256);
    `);
  },
};

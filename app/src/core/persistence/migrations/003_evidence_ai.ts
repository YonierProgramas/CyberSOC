import type { Migration } from '../MigrationRunner';

export const evidenceAiMigration: Migration = {
  version: 3,
  name: '003_evidence_ai',
  up(database) {
    database.exec(`
ALTER TABLE scan_results ADD COLUMN detected_type TEXT;
ALTER TABLE scan_results ADD COLUMN engine_score INTEGER;
ALTER TABLE scan_results ADD COLUMN risk_level TEXT;
ALTER TABLE scan_results ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED';
CREATE INDEX idx_results_score ON scan_results(engine_score);

CREATE TABLE evidences (
  id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE,
  evidence_key TEXT NOT NULL,            -- ev1, ev2… (lo que ve la IA)
  source TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL,
  severity TEXT NOT NULL, points INTEGER NOT NULL,
  decisive INTEGER NOT NULL DEFAULT 0, confidence REAL, details_json TEXT,
  UNIQUE (result_id, evidence_key)
);

CREATE TABLE risk_assessments (
  result_id TEXT PRIMARY KEY REFERENCES scan_results(id) ON DELETE CASCADE,
  engine_verdict TEXT NOT NULL, engine_score INTEGER NOT NULL,
  ai_opinion TEXT, ai_confidence REAL,
  final_verdict TEXT NOT NULL, final_level TEXT NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,                  -- ENGINE | AI_ESCALATION | USER_ALLOWLIST
  trace_json TEXT NOT NULL, policy_version TEXT NOT NULL, decided_at TEXT NOT NULL
);

CREATE TABLE ai_analyses (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                    -- FILE_RESULT | JOB_SUMMARY
  result_id TEXT REFERENCES scan_results(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES scan_jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, model TEXT, prompt_version TEXT NOT NULL,
  context_json TEXT NOT NULL, context_sha256 TEXT NOT NULL,
  response_json TEXT,
  validation_status TEXT NOT NULL,       -- VALID | INVALID_JSON | SCHEMA_ERROR | UNKNOWN_EVIDENCE | UNSAFE | INCOMPLETE | PROVIDER_ERROR
  error_kind TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_result ON ai_analyses(result_id);

CREATE TABLE result_layers (           -- traza de capas (D18)
  result_id TEXT NOT NULL REFERENCES scan_results(id) ON DELETE CASCADE,
  layer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RAN','SKIPPED','DISABLED','ERROR')),
  reason TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  PRIMARY KEY (result_id, layer)
);
CREATE INDEX idx_layers_layer ON result_layers(layer, status);
    `);
  },
};

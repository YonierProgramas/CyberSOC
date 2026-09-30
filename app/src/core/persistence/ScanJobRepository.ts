import type { StatementSync } from 'node:sqlite';
import type { Database } from './Database';
import { requireNonNegativeInteger } from './validation';

export type ScanJobStatus =
  | 'CREATED'
  | 'DISCOVERING'
  | 'SCANNING'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED';

export interface ScanJobCounters {
  filesDiscovered: number;
  filesProcessed: number;
  filesError: number;
  filesSkipped: number;
  bytesProcessed: number;
}

export interface ScanJobRecord extends ScanJobCounters {
  id: string;
  targetPath: string;
  targetKind: 'FILE' | 'FOLDER';
  status: ScanJobStatus;
  engineVersion: string | null;
  protocolVersion: string | null;
  metricsJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateScanJob {
  id: string;
  targetPath: string;
  targetKind: ScanJobRecord['targetKind'];
  engineVersion?: string | null;
  protocolVersion?: string | null;
  createdAt?: string;
}

export type ScanJobStatusDetails = Partial<
  Pick<ScanJobRecord, 'startedAt' | 'finishedAt' | 'errorMessage'>
>;

const selectJob = `SELECT
  id, target_path AS targetPath, target_kind AS targetKind, status,
  files_discovered AS filesDiscovered, files_processed AS filesProcessed,
  files_error AS filesError, files_skipped AS filesSkipped, bytes_processed AS bytesProcessed,
  engine_version AS engineVersion, protocol_version AS protocolVersion,
  metrics_json AS metricsJson, error_message AS errorMessage,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
FROM scan_jobs`;

export class ScanJobRepository {
  private readonly insert: StatementSync;
  private readonly setStatus: StatementSync;
  private readonly setCounters: StatementSync;
  private readonly find: StatementSync;
  private readonly recent: StatementSync;

  constructor(database: Database) {
    this.insert = database.prepare(`INSERT INTO scan_jobs
      (id, target_path, target_kind, status, engine_version, protocol_version, created_at)
      VALUES (?, ?, ?, 'CREATED', ?, ?, ?)`);
    this.setStatus = database.prepare(`UPDATE scan_jobs SET
      status = ?,
      started_at = CASE WHEN ? THEN ? ELSE started_at END,
      finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
      error_message = CASE WHEN ? THEN ? ELSE error_message END
      WHERE id = ?`);
    this.setCounters = database.prepare(`UPDATE scan_jobs SET
      files_discovered = ?, files_processed = ?, files_error = ?, files_skipped = ?,
      bytes_processed = ?, metrics_json = CASE WHEN ? THEN ? ELSE metrics_json END
      WHERE id = ?`);
    this.find = database.prepare(`${selectJob} WHERE id = ?`);
    this.recent = database.prepare(
      `${selectJob} ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
  }

  create(input: CreateScanJob): ScanJobRecord {
    this.insert.run(
      input.id,
      input.targetPath,
      input.targetKind,
      input.engineVersion ?? null,
      input.protocolVersion ?? null,
      input.createdAt ?? new Date().toISOString(),
    );
    return this.get(input.id)!;
  }

  // Transition rules belong to ScanJob (T1.4); SQLite checks the allowed states.
  updateStatus(
    id: string,
    status: ScanJobStatus,
    details: ScanJobStatusDetails = {},
  ): void {
    const { changes } = this.setStatus.run(
      status,
      Number(details.startedAt !== undefined),
      details.startedAt ?? null,
      Number(details.finishedAt !== undefined),
      details.finishedAt ?? null,
      Number(details.errorMessage !== undefined),
      details.errorMessage ?? null,
      id,
    );
    if (changes === 0) throw new Error(`No existe el trabajo ${id}.`);
  }

  // Counters are absolute snapshots, so retrying an update does not double-count.
  updateCounters(
    id: string,
    counters: ScanJobCounters & { metricsJson?: string | null },
  ): void {
    for (const field of [
      'filesDiscovered',
      'filesProcessed',
      'filesError',
      'filesSkipped',
      'bytesProcessed',
    ] as const) {
      requireNonNegativeInteger(counters[field], field);
    }
    const { changes } = this.setCounters.run(
      counters.filesDiscovered,
      counters.filesProcessed,
      counters.filesError,
      counters.filesSkipped,
      counters.bytesProcessed,
      Number(counters.metricsJson !== undefined),
      counters.metricsJson ?? null,
      id,
    );
    if (changes === 0) throw new Error(`No existe el trabajo ${id}.`);
  }

  get(id: string): ScanJobRecord | undefined {
    return this.find.get(id) as unknown as ScanJobRecord | undefined;
  }

  listRecent(limit = 20): ScanJobRecord[] {
    requireNonNegativeInteger(limit, 'limit');
    return this.recent.all(limit) as unknown as ScanJobRecord[];
  }
}

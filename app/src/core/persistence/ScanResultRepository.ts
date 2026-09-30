import type { StatementSync } from 'node:sqlite';
import type { FileErrorCode, FileScanStatus } from '../domain/types';
import type { Database } from './Database';
import { requireNonNegativeInteger } from './validation';

export interface ScanResultRecord {
  id: string;
  jobId: string;
  seq: number;
  path: string;
  fileName: string;
  extension: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  status: FileScanStatus;
  sha256: string | null;
  verdict:
    'NOT_EVALUATED' | 'CLEAN' | 'SUSPICIOUS' | 'DETECTED' | 'NOT_ANALYZED';
  errorCode: FileErrorCode | null;
  errorMessage: string | null;
  durationMs: number | null;
  scannedAt: string;
}

export interface InsertScanResult {
  id: string;
  jobId: string;
  seq: number;
  path: string;
  fileName: string;
  status: FileScanStatus;
  extension?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  sha256?: string | null;
  errorCode?: FileErrorCode | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  scannedAt?: string;
}

const selectResult = `SELECT
  id, job_id AS jobId, seq, path, file_name AS fileName, extension,
  size_bytes AS sizeBytes, modified_at AS modifiedAt, status, sha256, verdict,
  error_code AS errorCode, error_message AS errorMessage,
  duration_ms AS durationMs, scanned_at AS scannedAt
FROM scan_results`;

export class ScanResultRepository {
  private readonly insert: StatementSync;
  private readonly find: StatementSync;
  private readonly byJob: StatementSync;

  constructor(private readonly database: Database) {
    // S1 always uses the migration's NOT_EVALUATED default; no verdict is inferred.
    this.insert = database.prepare(`INSERT INTO scan_results
      (id, job_id, seq, path, file_name, extension, size_bytes, modified_at, status,
       sha256, error_code, error_message, duration_ms, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.find = database.prepare(`${selectResult} WHERE id = ?`);
    this.byJob = database.prepare(
      `${selectResult} WHERE job_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
    );
  }

  insertResult(input: InsertScanResult): ScanResultRecord {
    requireNonNegativeInteger(input.seq, 'seq');
    return this.database.transaction(() => {
      this.insert.run(
        input.id,
        input.jobId,
        input.seq,
        input.path,
        input.fileName,
        input.extension ?? null,
        input.sizeBytes ?? null,
        input.modifiedAt ?? null,
        input.status,
        input.sha256 ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.durationMs ?? null,
        input.scannedAt ?? new Date().toISOString(),
      );
      return this.find.get(input.id) as unknown as ScanResultRecord;
    });
  }

  listByJob(jobId: string, offset: number, limit: number): ScanResultRecord[] {
    requireNonNegativeInteger(offset, 'offset');
    requireNonNegativeInteger(limit, 'limit');
    return this.byJob.all(
      jobId,
      limit,
      offset,
    ) as unknown as ScanResultRecord[];
  }
}

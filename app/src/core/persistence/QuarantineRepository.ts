import type { Database } from './Database';

export type QuarantineStatus =
  'PENDING' | 'QUARANTINED' | 'RESTORED' | 'DELETED' | 'FAILED';
export interface QuarantineRecord {
  id: string;
  resultId: string | null;
  originalPath: string;
  sha256: string;
  sizeBytes: number;
  vaultFile: string;
  keyB64: string;
  ivB64: string;
  authTagB64: string | null;
  reason: string;
  verdictSnapshot: string;
  status: QuarantineStatus;
  quarantinedAt: string | null;
  restoredAt: string | null;
  restoredTo: string | null;
  deletedAt: string | null;
  errorMessage: string | null;
}
export type QuarantineItem = Omit<
  QuarantineRecord,
  'keyB64' | 'ivB64' | 'authTagB64'
>;
export function publicItem(record: QuarantineRecord): QuarantineItem {
  return {
    id: record.id,
    resultId: record.resultId,
    originalPath: record.originalPath,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    vaultFile: record.vaultFile,
    reason: record.reason,
    verdictSnapshot: record.verdictSnapshot,
    status: record.status,
    quarantinedAt: record.quarantinedAt,
    restoredAt: record.restoredAt,
    restoredTo: record.restoredTo,
    deletedAt: record.deletedAt,
    errorMessage: record.errorMessage,
  };
}
const columns = `id, result_id AS resultId, original_path AS originalPath,
 sha256, size_bytes AS sizeBytes, vault_file AS vaultFile, key_b64 AS keyB64,
 iv_b64 AS ivB64, auth_tag_b64 AS authTagB64, reason, verdict_snapshot AS verdictSnapshot,
 status, quarantined_at AS quarantinedAt, restored_at AS restoredAt, restored_to AS restoredTo,
 deleted_at AS deletedAt, error_message AS errorMessage`;

export class QuarantineRepository {
  constructor(private readonly db: Database) {}
  get(id: string): QuarantineRecord | undefined {
    return this.db
      .prepare(`SELECT ${columns} FROM quarantine_items WHERE id=?`)
      .get(id) as unknown as QuarantineRecord | undefined;
  }
  list(status?: QuarantineStatus): QuarantineRecord[] {
    return (status
      ? this.db
          .prepare(
            `SELECT ${columns} FROM quarantine_items WHERE status=? ORDER BY rowid`,
          )
          .all(status)
      : this.db
          .prepare(`SELECT ${columns} FROM quarantine_items ORDER BY rowid`)
          .all()) as unknown as QuarantineRecord[];
  }
  insert(item: QuarantineRecord): void {
    this.db
      .prepare(
        `INSERT INTO quarantine_items
      (id,result_id,original_path,sha256,size_bytes,vault_file,key_b64,iv_b64,auth_tag_b64,
       reason,verdict_snapshot,status,quarantined_at,restored_at,restored_to,deleted_at,error_message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        item.id,
        item.resultId,
        item.originalPath,
        item.sha256,
        item.sizeBytes,
        item.vaultFile,
        item.keyB64,
        item.ivB64,
        item.authTagB64,
        item.reason,
        item.verdictSnapshot,
        item.status,
        item.quarantinedAt,
        item.restoredAt,
        item.restoredTo,
        item.deletedAt,
        item.errorMessage,
      );
  }
  update(item: QuarantineRecord): void {
    const result = this.db
      .prepare(
        `UPDATE quarantine_items SET status=?,auth_tag_b64=?,
      quarantined_at=?,restored_at=?,restored_to=?,deleted_at=?,error_message=? WHERE id=?`,
      )
      .run(
        item.status,
        item.authTagB64,
        item.quarantinedAt,
        item.restoredAt,
        item.restoredTo,
        item.deletedAt,
        item.errorMessage,
        item.id,
      );
    if (result.changes !== 1)
      throw new Error('No existe el ítem de cuarentena.');
  }
}

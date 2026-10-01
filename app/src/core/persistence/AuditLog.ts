import { randomUUID } from 'node:crypto';
import type { Database } from './Database';

export interface AuditEntry {
  id: string;
  ts: string;
  actor: 'USER' | 'SYSTEM' | 'AI';
  action: string;
  targetType: string | null;
  targetId: string | null;
  detailsJson: string | null;
}
/** Solo se registran hechos de la operación; nunca claves de cifrado ni contenido de archivos. */
export class AuditLog {
  constructor(private readonly db: Database) {}
  append(
    action: string,
    targetId: string,
    details: Record<string, unknown> = {},
    actor: AuditEntry['actor'] = 'USER',
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log
      (id,ts,actor,action,target_type,target_id,details_json) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        new Date().toISOString(),
        actor,
        action,
        'QUARANTINE',
        targetId,
        JSON.stringify(details),
      );
  }
  list(targetId?: string): AuditEntry[] {
    const sql = `SELECT id,ts,actor,action,target_type AS targetType,target_id AS targetId,details_json AS detailsJson FROM audit_log`;
    return (targetId === undefined
      ? this.db.prepare(`${sql} ORDER BY rowid`).all()
      : this.db
          .prepare(`${sql} WHERE target_id=? ORDER BY rowid`)
          .all(targetId)) as unknown as AuditEntry[];
  }
}

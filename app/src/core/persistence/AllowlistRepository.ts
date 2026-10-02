import type { Database } from './Database';

export class AllowlistRepository {
  constructor(private readonly db: Database) {}
  has(sha256: string | null | undefined): boolean {
    if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) return false;
    return (
      this.db
        .prepare('SELECT 1 FROM allowlist WHERE sha256=?')
        .get(sha256.toLowerCase()) !== undefined
    );
  }
  add(sha256: string, reason: string): void {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('SHA-256 inválido.');
    this.db
      .prepare(
        `INSERT INTO allowlist (sha256,reason,created_at) VALUES (?,?,?)
      ON CONFLICT(sha256) DO UPDATE SET reason=excluded.reason`,
      )
      .run(sha256.toLowerCase(), reason, new Date().toISOString());
  }
  list(): Array<{ sha256: string; reason: string | null; createdAt: string }> {
    return this.db
      .prepare(
        'SELECT sha256,reason,created_at AS createdAt FROM allowlist ORDER BY created_at,sha256',
      )
      .all() as unknown as Array<{
      sha256: string;
      reason: string | null;
      createdAt: string;
    }>;
  }
}

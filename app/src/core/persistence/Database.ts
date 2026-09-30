import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export class Database {
  private readonly connection: DatabaseSync;
  private closed = false;
  private transactionDepth = 0;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    try {
      this.connection.exec(
        'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;',
      );
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  exec(sql: string): void {
    this.connection.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.connection.prepare(sql);
  }

  transaction<T>(operation: () => T): T {
    // Los repositorios pueden componer operaciones síncronas. Un SAVEPOINT no
    // confirma la transacción exterior: solo el nivel cero hace COMMIT.
    const nested = this.transactionDepth > 0;
    const savepoint = `repository_${this.transactionDepth}`;
    this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = operation();
      this.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) {
        this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else {
        this.exec('ROLLBACK');
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  close(): void {
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
  }
}

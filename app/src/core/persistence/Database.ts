import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export class Database {
  private readonly connection: DatabaseSync;
  private closed = false;

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
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      this.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
  }
}

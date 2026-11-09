import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export class Database {
  private readonly connection: DatabaseSync;
  private closed = false;
  private transactionDepth = 0;
  private reading = false;

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
    if (this.reading) throw new Error('Cannot write during a read.');
    // Repositories may compose synchronous operations. A SAVEPOINT does not
    // commit the outer transaction: only level zero issues COMMIT.
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

  /** Snapshot of synchronous SELECTs. WAL allows another writer without mixing instants.
   * query_only prevents accidental DML/DDL; it does not hold a transaction across await.
   */
  readTransaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0)
      throw new Error('The read requires an independent transaction.');
    const run = () => {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new TypeError('The read must be synchronous.');
      return result;
    };
    if (this.reading) return run();
    const previous = Number(
      this.prepare('PRAGMA query_only').get()!.query_only,
    );
    this.exec('PRAGMA query_only = ON');
    try {
      this.exec('BEGIN');
      this.reading = true;
      try {
        const value = run();
        this.exec('COMMIT');
        return value;
      } catch (error) {
        this.exec('ROLLBACK');
        throw error;
      } finally {
        this.reading = false;
      }
    } finally {
      this.exec(`PRAGMA query_only = ${previous ? 'ON' : 'OFF'}`);
    }
  }
}

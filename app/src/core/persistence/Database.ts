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
    if (this.reading)
      throw new Error('No se puede escribir durante una lectura.');
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

  /** Snapshot de SELECT síncronos. WAL permite otro escritor sin mezclar instantes.
   * query_only impide DML/DDL por accidente; no sostiene una transacción durante await.
   */
  readTransaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0)
      throw new Error('La lectura requiere una transacción independiente.');
    const run = () => {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new TypeError('La lectura debe ser síncrona.');
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

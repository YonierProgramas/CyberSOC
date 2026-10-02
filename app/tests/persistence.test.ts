import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { createDatabase } from '../src/main/composition-root';

describe('SQLite con una base temporal', () => {
  let directory: string;
  let database: Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-sqlite-'));
    database = new Database(
      join(directory, 'usuario con tilde á', 'cybersoc.db'),
    );
  });

  afterEach(() => {
    database.close();
    // Only this test's freshly allocated temporary directory is removed.
    rmSync(directory, { recursive: true, force: true });
  });

  it('activa WAL y claves foraneas en cada conexion', () => {
    expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({
      journal_mode: 'wal',
    });
    expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({
      foreign_keys: 1,
    });
    database.exec(
      'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));',
    );
    expect(() => database.exec('INSERT INTO child VALUES (99)')).toThrow();
    database.close();
    database = new Database(database.path);
    expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({
      foreign_keys: 1,
    });
    expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({
      journal_mode: 'wal',
    });
  });

  it('crea exactamente el esquema 001 del plan', () => {
    expect(new MigrationRunner(database, [initialMigration]).run()).toEqual([
      1,
    ]);
    expect(database.prepare('SELECT * FROM schema_migrations').all()).toEqual([
      { version: 1, name: '001_init', applied_at: expect.any(String) },
    ]);
    const columns = (table: string) =>
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    expect(columns('schema_migrations')).toEqual([
      { name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
    expect(columns('settings')).toEqual([
      { name: 'key', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'value_json', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
  });

  it('no reaplica la migracion ni altera datos o fechas tras reabrir', () => {
    const runner = new MigrationRunner(database);
    runner.run();
    const history = database.prepare('SELECT * FROM schema_migrations').all();
    database
      .prepare('INSERT INTO settings VALUES (?, ?, ?)')
      .run('tema', '{"nombre":"oscuro"}', '2026-09-30T00:00:00Z');
    expect(runner.run()).toEqual([]);
    database.close();
    database = new Database(database.path);
    expect(new MigrationRunner(database).run()).toEqual([]);
    expect(database.prepare('SELECT * FROM schema_migrations').all()).toEqual(
      history,
    );
    expect(
      database
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get('tema'),
    ).toMatchObject({ value_json: '{"nombre":"oscuro"}' });
  });

  it('revierte esquema e historial si una migracion falla', () => {
    const runner = new MigrationRunner(database, [
      initialMigration,
      {
        version: 2,
        name: '002_broken',
        up(db) {
          db.exec('CREATE TABLE partial (id INTEGER);');
          throw new Error('Fallo simulado');
        },
      },
    ]);
    expect(() => runner.run()).toThrow('Fallo simulado');
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
    ).toEqual([]);
    expect(new MigrationRunner(database).run()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rechaza historial desconocido sin modificarlo', () => {
    new MigrationRunner(database).run();
    database.exec(
      "INSERT INTO schema_migrations VALUES (7, '007_future', 'unchanged')",
    );
    const history = database.prepare('SELECT * FROM schema_migrations').all();
    expect(() => new MigrationRunner(database).run()).toThrow('historial');
    expect(database.prepare('SELECT * FROM schema_migrations').all()).toEqual(
      history,
    );
  });

  it('rechaza versiones repetidas antes de escribir', () => {
    expect(() =>
      new MigrationRunner(database, [initialMigration, initialMigration]).run(),
    ).toThrow('crecientes');
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
    ).toEqual([]);
  });

  it('cierra de forma idempotente y libera el archivo', () => {
    database.close();
    expect(() => database.close()).not.toThrow();
    expect(() => database.prepare('SELECT 1')).toThrow();
    database = new Database(database.path);
    expect(new MigrationRunner(database).run()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('composition root usa la ruta inyectada y migra antes de devolver la BD', () => {
    const created = createDatabase(directory);
    try {
      expect(created.path).toBe(join(directory, 'cybersoc.db'));
      expect(
        created
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get(),
      ).toMatchObject({ version: 6 });
    } finally {
      created.close();
    }
  });
});

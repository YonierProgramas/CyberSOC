import type { Database } from './Database';
import { initialMigration } from './migrations/001_init';
import { scansMigration } from './migrations/002_scans';
import { evidenceAiMigration } from './migrations/003_evidence_ai';
import { zonesMigration } from './migrations/004_zones';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(database: Database): void;
}

export class MigrationRunner {
  constructor(
    private readonly database: Database,
    private readonly migrations: readonly Migration[] = [
      initialMigration,
      scansMigration,
      evidenceAiMigration,
      zonesMigration,
    ],
  ) {}

  run(): number[] {
    let previousVersion = 0;
    for (const migration of this.migrations) {
      if (
        !Number.isSafeInteger(migration.version) ||
        migration.version <= previousVersion ||
        !migration.name.trim()
      ) {
        throw new Error(
          'Las migraciones deben tener nombre y versiones positivas crecientes.',
        );
      }
      previousVersion = migration.version;
    }

    return this.database.transaction(() => {
      const hasHistory = this.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get();
      const history = hasHistory
        ? this.database
            .prepare(
              'SELECT version, name FROM schema_migrations ORDER BY version',
            )
            .all()
        : [];
      for (const [index, record] of history.entries()) {
        const migration = this.migrations[index];
        if (
          !migration ||
          migration.version !== record.version ||
          migration.name !== record.name
        ) {
          throw new Error(
            'El historial de migraciones no coincide con esta version de la app.',
          );
        }
      }

      const applied: number[] = [];
      for (const migration of this.migrations.slice(history.length)) {
        migration.up(this.database);
        this.database
          .prepare(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          )
          .run(migration.version, migration.name, new Date().toISOString());
        applied.push(migration.version);
      }
      return applied;
    });
  }
}

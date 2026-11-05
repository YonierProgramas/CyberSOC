import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from './Database';
import { MigrationRunner } from './MigrationRunner';

const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** No guarda contenido: una huella por fila, ordenada para conservar duplicados.
 * Invariante: el arreglo tiene exactamente una entrada por fila, incluso repetida.
 * Inserción O(1) amortizada; ordenar O(n log n), memoria O(n) huellas de 64 bytes.
 */
function inspect(connection: DatabaseSync) {
  if (
    connection
      .prepare('PRAGMA integrity_check')
      .all()
      .some((row) => row.integrity_check !== 'ok') ||
    connection.prepare('PRAGMA foreign_key_check').all().length
  ) {
    throw new Error('La base o su copia no superan integridad/FK.');
  }
  const tables = connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return tables.map(({ name }) => {
    if (typeof name !== 'string') throw new Error('Tabla inválida.');
    const rows: string[] = [];
    for (const row of connection
      .prepare(`SELECT * FROM ${quote(name)}`)
      .iterate()) {
      rows.push(
        digest(
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === 'bigint'
              ? { bigint: value.toString() }
              : value instanceof Uint8Array
                ? { blob: Buffer.from(value).toString('hex') }
                : value,
          ),
        ),
      );
    }
    rows.sort();
    return { table: name, count: rows.length, sha256: digest(rows.join('\n')) };
  });
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  if (
    lstatSync(path).isSymbolicLink() ||
    realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()
  ) {
    throw new Error('El perfil/backup no puede atravesar enlaces.');
  }
}

function durableWrite(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Llamar solo después del lock de instancia, antes de workers/repositorios.
 * BEGIN IMMEDIATE impide escritores desde inspección hasta COMMIT de migraciones.
 * VACUUM INTO, en otra conexión lectora, incluye páginas confirmadas del WAL.
 * No se copia un .db activo con copyFile ni se sobrescribe una copia anterior.
 */
export function openDatabaseWithBackup(
  profile: string,
  appVersion: string,
): Database {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(appVersion))
    throw new Error('Versión inválida.');
  ensureDirectory(profile);
  const profileId = digest(realpathSync(profile).toLowerCase());
  const path = join(profile, 'cybersoc.db');
  const existed = existsSync(path);
  if (existed && lstatSync(path).isSymbolicLink())
    throw new Error('Base enlazada no admitida.');
  const markerPath = join(profile, 'distribution-profile.json');
  const marker = existsSync(markerPath)
    ? (JSON.parse(readFileSync(markerPath, 'utf8')) as {
        profileId?: string;
        appVersion?: string;
        schemaVersion?: number;
      })
    : null;
  if (
    marker &&
    (marker.profileId !== profileId || marker.schemaVersion !== 7)
  ) {
    throw new Error('Perfil incompatible: no se abre ni migra.');
  }
  if (marker?.appVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(marker.appVersion))
      throw new Error('Versión de perfil inválida.');
    const previous = marker.appVersion.split(/[.-]/).slice(0, 3).map(Number);
    const current = appVersion.split(/[.-]/).slice(0, 3).map(Number);
    const difference = current.findIndex(
      (value, index) => value !== previous[index],
    );
    if (difference !== -1 && current[difference]! < previous[difference]!)
      throw new Error(
        'El perfil requiere una versión compatible más reciente.',
      );
  }
  // La conexión se abre para bloquear/leer; ninguna migración ni escritor de app corre aquí.
  const database = new Database(path);
  try {
    database.transaction(() => {
      const hasHistory = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='schema_migrations'",
        )
        .get();
      const version = hasHistory
        ? Number(
            database
              .prepare(
                'SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations',
              )
              .get()!.v,
          )
        : 0;
      if (version > 7 || !Number.isSafeInteger(version) || version < 0)
        throw new Error('Esquema incompatible. No hay downgrade.');
      if (existed && (version < 7 || marker?.appVersion !== appVersion)) {
        const backups = join(profile, 'backups');
        ensureDirectory(backups);
        const directory = join(
          backups,
          `before-${appVersion}-schema${version}-${randomUUID()}`,
        );
        mkdirSync(directory, { mode: 0o700 });
        const destination = join(directory, 'cybersoc.db');
        const source = new DatabaseSync(path, { readOnly: true });
        let original: ReturnType<typeof inspect>;
        try {
          original = inspect(source);
          source.prepare('VACUUM INTO ?').run(destination);
        } finally {
          source.close();
        }
        // VACUUM INTO termina su snapshot; fsync y reapertura comprueban bytes persistidos.
        const fd = openSync(destination, 'r+');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const copy = new DatabaseSync(destination, { readOnly: true });
        try {
          if (JSON.stringify(inspect(copy)) !== JSON.stringify(original))
            throw new Error('Copia distinta del original.');
        } finally {
          copy.close();
        }
        durableWrite(join(directory, 'verified.json'), {
          schema: 1,
          appVersion,
          schemaVersion: version,
          profileId,
          databaseSha256: digest(readFileSync(destination)),
          tables: original,
          recovery:
            'Restaurar solo con versión compatible; no downgrade de 007.',
        });
      }
      new MigrationRunner(database).run();
    });
    const temporary = join(profile, `distribution-profile-${randomUUID()}.tmp`);
    durableWrite(temporary, {
      schema: 1,
      profileId,
      appVersion,
      schemaVersion: 7,
    });
    renameSync(temporary, markerPath);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

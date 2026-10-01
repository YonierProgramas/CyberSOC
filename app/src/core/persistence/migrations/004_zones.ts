import type { Migration } from '../MigrationRunner';

export const zonesMigration: Migration = {
  version: 4,
  name: '004_zones',
  up(database) {
    database.exec(`
ALTER TABLE scan_jobs ADD COLUMN ruleset_version TEXT;
ALTER TABLE scan_jobs ADD COLUMN signatures_version TEXT;
ALTER TABLE scan_jobs ADD COLUMN profile_json TEXT;      -- perfil(es) aplicados o plan aceptado
ALTER TABLE scan_results ADD COLUMN zone TEXT;           -- DESCARGAS, EXTRAIBLE, SISTEMA…
CREATE INDEX idx_results_zone ON scan_results(zone);
    `);
  },
};

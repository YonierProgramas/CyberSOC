import { z } from 'zod';
import { layerSchema, zoneSchema, type Zone } from '../../shared/protocol';
import { scanProfileSchema, type ScanProfile } from '../../shared/scan-profile';
import type { Database } from '../persistence/Database';

const settingsKey = 'scan.zoneProfiles.v1';
const profilesSchema = z.record(zoneSchema, scanProfileSchema);

export class ScanProfiles {
  // Invariante: hay un perfil válido por cada zona y nunca faltan HASH/SIGNATURES.
  // Map consulta/actualiza una zona en O(1) promedio; cargar/copiar cuesta O(Z·L).
  private readonly profiles = new Map<Zone, ScanProfile>();

  constructor(private readonly database?: Database) {
    for (const zone of zoneSchema.options) {
      const broad = ['DESCARGAS', 'TEMPORALES', 'EXTRAIBLE'].includes(zone);
      const layers =
        zone === 'SISTEMA'
          ? ['HASH', 'SIGNATURES', 'FILETYPE']
          : zone === 'PROGRAMAS'
            ? ['HASH', 'SIGNATURES', 'FILETYPE', 'RULES']
            : [...layerSchema.options];
      this.profiles.set(
        zone,
        scanProfileSchema.parse({
          layers,
          includeHidden: broad,
          maxFileSizeMB: broad ? 512 : 256,
        }),
      );
    }
    const row = database
      ?.prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(settingsKey);
    if (row) {
      const saved = profilesSchema.parse(JSON.parse(String(row.value_json)));
      for (const zone of zoneSchema.options)
        this.profiles.set(zone, saved[zone]);
    } else if (database) this.persist();
  }

  get(zone: Zone): ScanProfile {
    // Copia defensiva: el llamante no puede desactivar capas del registro interno.
    return structuredClone(this.profiles.get(zoneSchema.parse(zone))!);
  }

  set(zone: Zone, value: ScanProfile): void {
    const key = zoneSchema.parse(zone);
    const profile = scanProfileSchema.parse(value);
    const previous = this.profiles.get(key)!;
    this.profiles.set(key, profile);
    try {
      this.persist();
    } catch (error) {
      this.profiles.set(key, previous);
      throw error;
    }
  }

  snapshot(): Record<Zone, ScanProfile> {
    return profilesSchema.parse(Object.fromEntries(this.profiles));
  }

  private persist(): void {
    this.database
      ?.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(
        settingsKey,
        JSON.stringify(this.snapshot()),
        new Date().toISOString(),
      );
  }
}

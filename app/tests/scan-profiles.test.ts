import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { ScanProfiles } from '../src/core/zones/ScanProfiles';
import { layerSchema, zoneSchema } from '../src/shared/protocol';
import { scanProfileChoiceSchema } from '../src/shared/scan-profile';

describe('Map de perfiles por zona', () => {
  const databases: Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });
  it('aplica todos los valores de la tabla del plan', () => {
    const profiles = new ScanProfiles();
    for (const zone of zoneSchema.options) {
      const profile = profiles.get(zone);
      const broad = ['DESCARGAS', 'TEMPORALES', 'EXTRAIBLE'].includes(zone);
      expect(profile.includeHidden).toBe(broad);
      expect(profile.maxFileSizeMB).toBe(broad ? 512 : 256);
      expect(profile.layers).toEqual(
        zone === 'SISTEMA'
          ? ['HASH', 'SIGNATURES', 'FILETYPE']
          : zone === 'PROGRAMAS'
            ? ['HASH', 'SIGNATURES', 'FILETYPE', 'RULES']
            : layerSchema.options,
      );
    }
  });
  it('persiste en settings y devuelve copias independientes', () => {
    const database = new Database(':memory:');
    databases.push(database);
    new MigrationRunner(database).run();
    const profiles = new ScanProfiles(database);
    const custom = {
      layers: ['HASH', 'SIGNATURES'] as const,
      includeHidden: true,
      maxFileSizeMB: 10,
    };
    profiles.set('SISTEMA', { ...custom, layers: [...custom.layers] });
    profiles.get('SISTEMA').layers.pop();
    profiles.snapshot().SISTEMA.layers.pop();
    expect(new ScanProfiles(database).get('SISTEMA')).toEqual(custom);
    expect(
      database.prepare('SELECT count(*) AS n FROM settings').get()?.n,
    ).toBe(1);
  });
  it.each([
    { layers: ['HASH'] },
    { layers: ['SIGNATURES'] },
    { layers: ['HASH', 'SIGNATURES', 'HASH'] },
    { layers: ['HASH', 'SIGNATURES', 'INVENTADA'] },
    { maxFileSizeMB: 0 },
    { maxFileSizeMB: 0.5 },
    { maxFileSizeMB: Infinity },
    { includeHidden: 'false' },
    { sorpresa: true },
  ])('rechaza perfil personalizado inválido: %j', (invalid) => {
    expect(() =>
      scanProfileChoiceSchema.parse({
        layers: ['HASH', 'SIGNATURES'],
        includeHidden: false,
        maxFileSizeMB: 20,
        ...invalid,
      }),
    ).toThrow();
  });
  it('acepta AUTO y un perfil válido', () => {
    expect(scanProfileChoiceSchema.parse('AUTO')).toBe('AUTO');
    expect(
      scanProfileChoiceSchema.parse(new ScanProfiles().get('SISTEMA')),
    ).toHaveProperty('includeHidden', false);
  });
  it('no tolera settings corruptos ni restaura silenciosamente capas', () => {
    const database = new Database(':memory:');
    databases.push(database);
    new MigrationRunner(database).run();
    new ScanProfiles(database);
    database.exec("UPDATE settings SET value_json = '{}'");
    expect(() => new ScanProfiles(database)).toThrow();
  });
});

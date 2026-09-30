import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { AppConfigStore } from '../src/core/config/AppConfig';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';

const defaults = {
  engine: { requestTimeoutMs: 30_000 },
  scan: { maxFileSizeMB: 256, queueCapacity: 1_000 },
  ai: {
    analysisModel: 'claude-haiku-4-5-20251001',
    assistantModel: 'claude-haiku-4-5-20251001',
    autoAnalyzeLimitPerScan: 50,
    sendFileNames: true,
  },
};

describe('AppConfig', () => {
  let directory: string;
  let database: Database;
  let store: AppConfigStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-config-'));
    database = new Database(join(directory, 'cybersoc.db'));
    new MigrationRunner(database).run();
    store = new AppConfigStore(database);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('devuelve los valores por defecto sin escribir en settings', () => {
    expect(store.load()).toEqual(defaults);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM settings').get(),
    ).toMatchObject({ count: 0 });
  });

  it.each([
    { engine: { requestTimeoutMs: 0 } },
    { engine: { requestTimeoutMs: 1.5 } },
    { engine: { requestTimeoutMs: '30000' } },
    { scan: { maxFileSizeMB: -1 } },
    { scan: { queueCapacity: 0 } },
    { ai: { analysisModel: '' } },
    { ai: { assistantModel: '' } },
    { ai: { autoAnalyzeLimitPerScan: -1 } },
    { ai: { sendFileNames: 'true' } },
    { extra: true },
  ])('rechaza %j y no guarda nada', (input) => {
    expect(() => store.save(input)).toThrow(ZodError);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM settings').get(),
    ).toMatchObject({ count: 0 });
  });

  it('conserva lo ya guardado cuando el cambio es invalido', () => {
    store.save({ engine: { requestTimeoutMs: 8_000 } });
    expect(() => store.save({ scan: { queueCapacity: 0 } })).toThrow(ZodError);
    expect(store.load().engine.requestTimeoutMs).toBe(8_000);
    expect(store.load().scan.queueCapacity).toBe(1_000);
  });

  it('persiste la configuracion al reabrir la base', () => {
    const saved = store.save({
      engine: { requestTimeoutMs: 12_000 },
      scan: { maxFileSizeMB: 32, queueCapacity: 4 },
      ai: {
        analysisModel: 'claude-haiku-4-5-20251001',
        assistantModel: 'claude-sonnet',
        autoAnalyzeLimitPerScan: 3,
        sendFileNames: false,
      },
    });
    database
      .prepare(
        'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      )
      .run('tema', '{"nombre":"oscuro"}', '2026-09-30T00:00:00.000Z');
    const path = database.path;
    database.close();
    database = new Database(path);
    expect(new MigrationRunner(database).run()).toEqual([]);
    expect(new AppConfigStore(database).load()).toEqual(saved);
    expect(
      database
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get('tema'),
    ).toMatchObject({ value_json: '{"nombre":"oscuro"}' });
  });

  it('rechaza un JSON de ajuste que no cumple el esquema', () => {
    database
      .prepare(
        'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      )
      .run('engine.requestTimeoutMs', '"no"', '2026-09-30T00:00:00.000Z');
    expect(() => store.load()).toThrow(ZodError);
  });
});

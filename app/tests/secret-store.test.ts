import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { AppConfigStore } from '../src/core/config/AppConfig';
import { createLogger } from '../src/core/logging/logger';

const native = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
}));
const app = vi.hoisted(() => ({ isPackaged: false, getPath: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: native, app }));
import { API_KEY_SETTING, SecretStore } from '../src/main/SecretStore';
import {
  createAIProvider,
  createAISettings,
  createSecretStore,
  createEngine,
} from '../src/main/composition-root';

// Credenciales ficticias, solo para pruebas con fetch y cifrado simulados.
const KEY = 'unit-test-secret-only-1234';
const NEXT = 'unit-test-replacement-5678';
const MODEL = 'claude-haiku-4-5-20251001';

describe('SecretStore y composición de Claude', () => {
  let directory: string;
  let db: Database;
  let store: SecretStore;
  beforeEach(() => {
    vi.resetAllMocks();
    app.isPackaged = false;
    directory = mkdtempSync(join(tmpdir(), 'cybersoc-secret-'));
    app.getPath.mockReturnValue(directory);
    db = new Database(join(directory, 'settings.db'));
    new MigrationRunner(db).run();
    native.isEncryptionAvailable.mockReturnValue(true);
    native.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
    native.encryptString.mockReturnValue(Buffer.from([0, 1, 2, 255, 77, 88]));
    native.decryptString.mockReturnValue(KEY);
    store = new SecretStore(db);
    vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    db.close();
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it('guarda solo ciphertext, sobrevive a reapertura y no altera AppConfig', () => {
    const config = new AppConfigStore(db);
    config.save({ ai: { autoAnalyzeLimitPerScan: 7 } });
    store.setApiKey(KEY);
    expect(native.encryptString).toHaveBeenCalledWith(KEY);
    const row = db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(API_KEY_SETTING)!;
    expect(String(row.value_json)).not.toContain(KEY);
    expect(JSON.parse(String(row.value_json))).toEqual({
      version: 1,
      ciphertext: 'AAEC/01Y',
    });
    expect(config.load().ai.autoAnalyzeLimitPerScan).toBe(7);
    db.close();
    db = new Database(db.path);
    store = new SecretStore(db);
    expect(store.getApiKey()).toBe(KEY);
    expect(native.decryptString).toHaveBeenCalledWith(
      Buffer.from([0, 1, 2, 255, 77, 88]),
    );
    expect(JSON.stringify(store)).not.toContain(KEY);
    expect(inspect(store, { showHidden: true })).not.toContain(KEY);
    expect(readFileSync(db.path).includes(Buffer.from(KEY))).toBe(false);
  });

  it('estado solo revela cuatro caracteres, clear es idempotente y no necesita descifrar', () => {
    expect(store.getStatus()).toEqual({ configured: false, last4: null });
    store.setApiKey(KEY);
    expect(store.getStatus()).toEqual({ configured: true, last4: '1234' });
    native.isEncryptionAvailable.mockReturnValue(false);
    store.clearApiKey();
    store.clearApiKey();
    expect(store.getStatus()).toEqual({ configured: false, last4: null });
  });

  it.each([
    undefined,
    null,
    123,
    {},
    '',
    'short',
    ' leading-key',
    'key-with\nnewline',
    'x'.repeat(1025),
  ])('rechaza claves inválidas sin SQL ni cifrado: caso %#', (key) => {
    expect(() => store.setApiKey(key)).toThrow('formato');
    expect(native.encryptString).not.toHaveBeenCalled();
    expect(store.getStatus().configured).toBe(false);
  });

  it('no guarda si safeStorage no está disponible ni degrada a texto plano', () => {
    native.isEncryptionAvailable.mockReturnValue(false);
    expect(() => store.setApiKey(KEY)).toThrow('forma segura');
    expect(native.encryptString).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM settings').all()).toEqual([]);
  });

  it.each(['basic_text', 'unknown'])('rechaza backend Linux %s', (backend) => {
    native.getSelectedStorageBackend.mockReturnValue(backend);
    expect(() =>
      new SecretStore(db, { platform: 'linux' }).setApiKey(KEY),
    ).toThrow('forma segura');
    expect(native.encryptString).not.toHaveBeenCalled();
  });

  it('mantiene la clave anterior si falla el reemplazo y elimina detalles de error', () => {
    store.setApiKey(KEY);
    const original = db.prepare('SELECT * FROM settings').all();
    native.encryptString.mockImplementation(() => {
      throw new Error(NEXT);
    });
    expect(() => store.setApiKey(NEXT)).toThrow('forma segura');
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(original);
    native.decryptString.mockImplementation(() => {
      throw new Error(KEY);
    });
    let failure: unknown;
    try {
      store.getStatus();
    } catch (error) {
      failure = error;
    }
    expect(inspect(failure, { showHidden: true })).not.toContain(KEY);
  });

  it.each([
    'not-json',
    '{"version":2,"ciphertext":"AAEC"}',
    '{"version":1,"ciphertext":"%%%"}',
  ])(
    'rechaza registro corrupto sin usar la alternativa de desarrollo: %#',
    (value) => {
      db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run(
        API_KEY_SETTING,
        value,
        'test',
      );
      const fallback = vi.fn(() => KEY);
      const invalid = new SecretStore(db, { developmentKey: fallback });
      expect(() => invalid.getApiKey()).toThrow('forma segura');
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it('acepta variable propia solo en desarrollo, prioriza BD y no persiste el entorno', () => {
    vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', NEXT);
    const configured = createSecretStore(db);
    expect(configured.getApiKey()).toBe(NEXT);
    expect(db.prepare('SELECT * FROM settings').all()).toEqual([]);
    configured.setApiKey(KEY);
    expect(configured.getApiKey()).toBe(KEY);
    configured.clearApiKey();
    expect(configured.getStatus().last4).toBe('5678');
    app.isPackaged = true;
    expect(createSecretStore(db).getApiKey()).toBeNull();
  });

  it('crea Claude con la clave vigente y el modelo de AppConfig; no filtra HTTP en estado ni logs', async () => {
    const fetch = vi.fn(async (_input: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get('x-api-key')).toBe(KEY);
      return new Response(
        JSON.stringify({
          id: KEY,
          type: 'model',
          display_name: 'test',
          created_at: '2026-01-01T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const service = createAISettings(db, { secrets: store });
    service.setApiKey(KEY);
    expect(service.getStatus()).toEqual({
      configured: true,
      last4: '1234',
      model: MODEL,
    });
    const reply = await service.testConnection();
    expect(reply).toMatchObject({
      ok: true,
      value: { model: MODEL },
      model: MODEL,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(JSON.stringify(reply)).not.toContain(KEY);
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'invalid_request_error', message: `echo ${KEY}` },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const failed = await service.testConnection();
    expect(failed).toMatchObject({
      ok: false,
      error: { kind: 'PROVIDER_DOWN' },
    });
    expect(JSON.stringify(failed)).not.toContain(KEY);
    const logger = createLogger(join(directory, 'logs'));
    expect(readFileSync(logger.filePath(), 'utf8')).not.toContain(KEY);
    // La redacción general existente también protege campos estructurados.
    logger.info(
      { component: 'test', apiKey: KEY, nested: { authorization: KEY } },
      'apiKey=' + KEY,
    );
    logger.flush();
    const logs = readFileSync(logger.filePath(), 'utf8');
    expect(logs).toContain('[Redacted]');
    expect(logs).not.toContain(KEY);
  });

  it('no reutiliza una credencial tras cambiarla o borrarla', async () => {
    const received: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        received.push(new Headers(init.headers).get('x-api-key'));
        return new Response(
          JSON.stringify({
            id: MODEL,
            type: 'model',
            display_name: 'test',
            created_at: '2026-01-01T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const service = createAISettings(db, { secrets: store });
    service.setApiKey(KEY);
    await service.testConnection();
    service.setApiKey(NEXT);
    native.decryptString.mockReturnValue(NEXT);
    await service.testConnection();
    service.clearApiKey();
    expect(await service.testConnection()).toMatchObject({
      ok: false,
      error: { kind: 'AUTH' },
    });
    expect(received).toEqual([KEY, NEXT]);
    expect(createAIProvider(db, store)).toBeNull();
  });

  it('excluye la variable de desarrollo del entorno del proceso motor', async () => {
    vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', KEY);
    const script = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const req = JSON.parse(line);
      const result = req.method === 'engine.hello'
        ? {protocol:'1', engineVersion: process.env.CYBERSOC_ANTHROPIC_API_KEY ? 'inherited' : 'isolated', python:'test', capabilities:[]}
        : {ok:true};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:req.id, result})+'\\n');
      if(req.method === 'engine.shutdown') process.exit(0);
    });`;
    vi.stubEnv(
      'CYBERSOC_ENGINE_CMD',
      JSON.stringify([process.execPath, '-e', script]),
    );
    const engine = createEngine(process.cwd(), directory);
    try {
      expect(await engine.reconnect()).toMatchObject({
        status: 'connected',
        engineVersion: 'isolated',
      });
    } finally {
      await engine.close();
    }
  });
});

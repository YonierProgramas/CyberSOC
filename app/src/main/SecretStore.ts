import { safeStorage } from 'electron';
import { z } from 'zod';
import type { Database } from '../core/persistence/Database';

export const API_KEY_SETTING = 'secrets.ai.apiKey';
export const apiKeySchema = z
  .string()
  .min(8)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const storedSchema = z.strictObject({
  version: z.literal(1),
  ciphertext: z
    .string()
    .min(4)
    .max(16384)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

type Encryption = Pick<
  typeof safeStorage,
  | 'isEncryptionAvailable'
  | 'encryptString'
  | 'decryptString'
  | 'getSelectedStorageBackend'
>;

export interface SecretStoreOptions {
  encryption?: Encryption;
  platform?: NodeJS.Platform;
  // Solo composition-root activa esta alternativa en una app sin empaquetar.
  developmentKey?: () => string | undefined;
}

export class SecretStore {
  readonly #database: Database;
  readonly #encryption: Encryption;
  readonly #platform: NodeJS.Platform;
  readonly #developmentKey: () => string | undefined;

  constructor(database: Database, options: SecretStoreOptions = {}) {
    this.#database = database;
    this.#encryption = options.encryption ?? safeStorage;
    this.#platform = options.platform ?? process.platform;
    this.#developmentKey = options.developmentKey ?? (() => undefined);
  }

  setApiKey(input: unknown): void {
    const parsed = apiKeySchema.safeParse(input);
    if (!parsed.success)
      throw new Error('La API key no tiene un formato válido.');
    try {
      this.requireEncryption();
      const encrypted = this.#encryption.encryptString(parsed.data);
      if (encrypted.length === 0) throw new Error();
      // El texto plano nunca llega a SQLite, tampoco como parámetro SQL.
      const value = JSON.stringify({
        version: 1,
        ciphertext: encrypted.toString('base64'),
      });
      this.#database.transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO settings (key, value_json, updated_at)
          VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json, updated_at = excluded.updated_at`,
          )
          .run(API_KEY_SETTING, value, new Date().toISOString());
      });
    } catch {
      // No adjuntar cause: un error de sistema/BD puede contener el secreto.
      throw new Error('No se pudo guardar la API key de forma segura.');
    }
  }

  clearApiKey(): void {
    try {
      this.#database.transaction(() => {
        this.#database
          .prepare('DELETE FROM settings WHERE key = ?')
          .run(API_KEY_SETTING);
      });
    } catch {
      throw new Error('No se pudo eliminar la API key guardada.');
    }
  }

  // Exclusivo de main. No se expone por IPC ni se conserva la clave en la instancia.
  getApiKey(): string | null {
    try {
      const row = this.#database
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get(API_KEY_SETTING);
      if (!row) {
        const value = this.#developmentKey();
        if (value === undefined || value === '') return null;
        return apiKeySchema.parse(value);
      }
      this.requireEncryption();
      const stored = storedSchema.parse(JSON.parse(String(row.value_json)));
      const encrypted = Buffer.from(stored.ciphertext, 'base64');
      if (encrypted.toString('base64') !== stored.ciphertext) throw new Error();
      return apiKeySchema.parse(this.#encryption.decryptString(encrypted));
    } catch {
      throw new Error('No se pudo leer la API key de forma segura.');
    }
  }

  getStatus(): { configured: boolean; last4: string | null } {
    const key = this.getApiKey();
    return {
      configured: key !== null,
      last4: key === null ? null : key.slice(-4),
    };
  }

  private requireEncryption(): void {
    if (
      !this.#encryption.isEncryptionAvailable() ||
      (this.#platform === 'linux' &&
        ['basic_text', 'unknown'].includes(
          this.#encryption.getSelectedStorageBackend(),
        ))
    ) {
      throw new Error('Cifrado del sistema no disponible.');
    }
  }
}

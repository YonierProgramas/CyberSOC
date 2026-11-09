import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import { SecretStore } from '../../src/main/SecretStore';

const directory = process.argv[2]!;
const phase = process.argv[3]!;
// Deliberately fake credential. No network request is made.
const key = 'unit-test-native-dpapi-only-9876';
app.setPath('userData', join(directory, 'profile'));
app
  .whenReady()
  .then(() => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('No disponible');
    const db = new Database(join(directory, 'native.db'));
    try {
      new MigrationRunner(db).run();
      const store = new SecretStore(db);
      if (phase === 'write') store.setApiKey(key);
      if (store.getApiKey() !== key || store.getStatus().last4 !== '9876')
        throw new Error('Descifrado incorrecto');
      if (phase === 'read') {
        store.clearApiKey();
        if (store.getStatus().configured) throw new Error('Borrado incorrecto');
      }
      for (const name of readdirSync(directory).filter((name) =>
        name.startsWith('native.db'),
      )) {
        if (readFileSync(join(directory, name)).includes(Buffer.from(key)))
          throw new Error('Texto plano en BD');
      }
      process.stdout.write('SECRET_STORE_NATIVE_OK\n');
    } finally {
      db.close();
    }
    app.quit();
  })
  .catch(() => {
    // The test does not print inputs or exceptions that might contain them either.
    process.stderr.write('SECRET_STORE_NATIVE_FAILED\n');
    app.exit(1);
  });

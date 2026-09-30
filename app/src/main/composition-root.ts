import { app } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Database } from '../core/persistence/Database';
import { MigrationRunner } from '../core/persistence/MigrationRunner';
import {
  asEngineLogger,
  EngineProcess,
  parseEngineCommand,
} from '../core/engine/EngineProcess';
import { createLogger } from '../core/logging/logger';
import { AppConfigStore } from '../core/config/AppConfig';
import { ScanJobRepository } from '../core/persistence/ScanJobRepository';
import { ScanResultRepository } from '../core/persistence/ScanResultRepository';
import { ScanOrchestrator } from '../core/scan/ScanOrchestrator';
import { ClaudeProvider } from '../core/ai/providers/ClaudeProvider';
import type { AIErrorKind } from '../core/ai/AIProvider';
import type { AIHealthCheck } from '../shared/ipc';
import type { AppLogger } from '../core/logging/logger';
import { SecretStore } from './SecretStore';
import type { AISettingsService } from './ipc/settings.ipc';

export function createSecretStore(database: Database): SecretStore {
  return new SecretStore(database, {
    developmentKey: () =>
      app.isPackaged ? undefined : process.env.CYBERSOC_ANTHROPIC_API_KEY,
  });
}

export function createAIProvider(
  database: Database,
  secrets = createSecretStore(database),
): ClaudeProvider | null {
  try {
    const apiKey = secrets.getApiKey();
    if (apiKey === null) return null;
    return new ClaudeProvider({
      apiKey,
      model: new AppConfigStore(database).load().ai.analysisModel,
    });
  } catch {
    throw new Error('No se pudo preparar el proveedor de IA.');
  }
}

export function createAISettings(
  database: Database,
  options: {
    secrets?: SecretStore;
    logger?: Pick<AppLogger, 'info' | 'warn'>;
  } = {},
): AISettingsService {
  const secrets = options.secrets ?? createSecretStore(database);
  const logger =
    options.logger ?? createLogger(join(app.getPath('userData'), 'logs'));
  return {
    setApiKey(key) {
      try {
        secrets.setApiKey(key);
        logger.info(
          { component: 'settings' },
          'API key guardada de forma cifrada.',
        );
      } catch {
        logger.warn(
          { component: 'settings' },
          'No se pudo guardar la API key.',
        );
        throw new Error('No se pudo guardar la API key.');
      }
    },
    clearApiKey() {
      try {
        secrets.clearApiKey();
        logger.info({ component: 'settings' }, 'API key guardada eliminada.');
      } catch {
        logger.warn(
          { component: 'settings' },
          'No se pudo eliminar la API key.',
        );
        throw new Error('No se pudo eliminar la API key.');
      }
    },
    getStatus() {
      try {
        return {
          ...secrets.getStatus(),
          model: new AppConfigStore(database).load().ai.analysisModel,
        };
      } catch {
        throw new Error('No se pudo consultar la configuración de IA.');
      }
    },
    async testConnection(): Promise<AIHealthCheck> {
      try {
        // Crear por petición evita usar una clave vieja tras reemplazarla/eliminarla.
        const provider = createAIProvider(database, secrets);
        if (provider === null)
          return {
            ok: false,
            error: {
              kind: 'AUTH',
              retryable: false,
              message: 'Configura una API key para probar la conexión.',
            },
          };
        const result = await provider.healthCheck();
        if (result.ok) {
          logger.info({ component: 'settings' }, 'Conexión de IA comprobada.');
          // Solo datos locales y numéricos: ni cuerpos HTTP ni model devuelto por la red.
          return {
            ok: true,
            value: { model: provider.model },
            model: provider.model,
            usage: { inputTokens: 0, outputTokens: 0 },
            latencyMs: result.latencyMs,
          };
        }
        logger.warn(
          { component: 'settings' },
          'No se pudo comprobar la conexión de IA.',
        );
        return {
          ok: false,
          error: {
            kind: result.error.kind,
            retryable: result.error.retryable,
            message: connectionErrorMessage(result.error.kind),
            ...(result.error.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: result.error.retryAfterMs }),
          },
        };
      } catch {
        logger.warn(
          { component: 'settings' },
          'Fallo al preparar o comprobar la conexión de IA.',
        );
        return {
          ok: false,
          error: {
            kind: 'PROVIDER_DOWN',
            retryable: false,
            message: 'No se pudo comprobar la conexión de IA.',
          },
        };
      }
    },
  };
}

function connectionErrorMessage(kind: AIErrorKind): string {
  switch (kind) {
    case 'AUTH':
      return 'La API de Claude rechazó la credencial.';
    case 'OFFLINE':
      return 'Sin conexión con la API de Claude.';
    case 'TIMEOUT':
      return 'La API de Claude no respondió a tiempo.';
    case 'RATE_LIMIT':
      return 'Se alcanzó el límite de peticiones de Claude.';
    default:
      return 'No se pudo comprobar la conexión de IA.';
  }
}

export function createScanOrchestrator(
  database: Database,
  engine: EngineProcess,
): ScanOrchestrator {
  const config = new AppConfigStore(database);
  return new ScanOrchestrator({
    config: () => config.load(),
    engine,
    jobs: new ScanJobRepository(database),
    results: new ScanResultRepository(database),
    onError: (error) => console.error('Error de escaneo:', error),
  });
}

export function createDatabase(userDataPath: string): Database {
  const database = new Database(join(userDataPath, 'cybersoc.db'));
  try {
    new MigrationRunner(database).run();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createEngine(
  appRoot: string,
  userDataPath = app.getPath('userData'),
): EngineProcess {
  const logger = createLogger(join(userDataPath, 'logs'));
  logger.info({ component: 'core' }, 'Logging started');
  return new EngineProcess({
    // La alternativa de desarrollo pertenece a main; el proceso Python no la necesita.
    spawnProcess: ((
      file: string,
      args: string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      const env = { ...options?.env };
      delete env.CYBERSOC_ANTHROPIC_API_KEY;
      return spawn(file, args, { ...options, env });
    }) as typeof spawn,
    cwd: appRoot,
    command: () =>
      process.env.CYBERSOC_ENGINE_CMD !== undefined
        ? parseEngineCommand(process.env.CYBERSOC_ENGINE_CMD)
        : {
            file: join(
              appRoot,
              '..',
              'engine',
              '.venv',
              process.platform === 'win32'
                ? 'Scripts/python.exe'
                : 'bin/python',
            ),
            args: ['-m', 'cybersoc_engine'],
          },
    logger: asEngineLogger(logger),
  });
}

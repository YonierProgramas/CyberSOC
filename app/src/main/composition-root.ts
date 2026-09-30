import { app } from 'electron';
import { join } from 'node:path';
import { Database } from '../core/persistence/Database';
import { MigrationRunner } from '../core/persistence/MigrationRunner';
import {
  asEngineLogger,
  EngineProcess,
  parseEngineCommand,
} from '../core/engine/EngineProcess';
import { createLogger } from '../core/logging/logger';

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

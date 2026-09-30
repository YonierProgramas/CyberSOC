import { join } from 'node:path';
import { Database } from '../core/persistence/Database';
import { MigrationRunner } from '../core/persistence/MigrationRunner';
import {
  EngineProcess,
  parseEngineCommand,
} from '../core/engine/EngineProcess';

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

export function createEngine(appRoot: string): EngineProcess {
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
    logger: {
      info: (message) => console.info('[engine]', message),
      error: (message) => console.error('[engine]', message),
    },
  });
}

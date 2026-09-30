import { join } from 'node:path';
import {
  EngineProcess,
  parseEngineCommand,
} from '../core/engine/EngineProcess';

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

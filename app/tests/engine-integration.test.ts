import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { EngineProcess } from '../src/core/engine/EngineProcess';

const python = resolve(
  '..',
  'engine',
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

it.skipIf(!existsSync(python))(
  'motor real: hello, ping, reconexion y shutdown',
  async () => {
    const messages: string[] = [];
    const engine = new EngineProcess({
      command: () => ({ file: python, args: ['-m', 'cybersoc_engine'] }),
      cwd: process.cwd(),
      logger: {
        info: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
    });
    try {
      expect(await engine.reconnect(), messages.join('\n')).toMatchObject({
        status: 'connected',
        protocol: '1',
      });
      expect(await engine.ping()).toHaveProperty('ts');
      expect((await engine.reconnect()).status).toBe('connected');
    } finally {
      await engine.close();
    }
    expect(engine.getState().status).toBe('disconnected');
  },
  15_000,
);

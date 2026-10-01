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
  'motor real: hello, ping, scan.file con HASH, SIGNATURES FILETYPE y RULES, reconexion y shutdown',
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
      const result = await engine.scanFile(
        {
          jobId: 'j_contract',
          taskId: 't_contract',
          path: resolve(
            '..',
            'contracts',
            'protocol-v1',
            'scan.file.request.json',
          ),
          options: { maxBytes: 1024 * 1024 },
        },
        5_000,
      );
      expect(result.status).toBe('SCANNED');
      expect(result.evidence).toEqual([]);
      expect(result.verdict).toBe('CLEAN');
      expect(result.score).toBe(0);
      expect(result.riskLevel).toBe('BAJO');
      expect(result.layers).toEqual([
        {
          layer: 'HASH',
          status: 'RAN',
          hits: 0,
          points: 0,
          ms: expect.any(Number),
        },
        {
          layer: 'SIGNATURES',
          status: 'RAN',
          hits: 0,
          points: 0,
          ms: expect.any(Number),
        },
        {
          layer: 'FILETYPE',
          status: 'RAN',
          hits: 0,
          points: 0,
          ms: expect.any(Number),
        },
        {
          layer: 'RULES',
          status: 'RAN',
          hits: 0,
          points: 0,
          ms: expect.any(Number),
        },
        {
          layer: 'HEURISTICS',
          status: 'RAN',
          hits: 0,
          points: 0,
          ms: expect.any(Number),
        },
        {
          layer: 'PE',
          status: 'SKIPPED',
          reason: 'NOT_PE',
          hits: 0,
          points: 0,
          ms: 0,
        },
        {
          layer: 'SCRIPTS',
          status: 'SKIPPED',
          reason: 'NOT_SCRIPT',
          hits: 0,
          points: 0,
          ms: 0,
        },
      ]);
      expect(result.layers[0]!.ms).toBeGreaterThanOrEqual(0);
      expect((await engine.reconnect()).status).toBe('connected');
    } finally {
      await engine.close();
    }
    expect(engine.getState().status).toBe('disconnected');
  },
  15_000,
);

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EngineProcess } from '../../src/core/engine/EngineProcess';
const resources = resolve(process.argv[2]!);
const engine = new EngineProcess({
  command: () => ({
    file: join(resources, 'runtime/python.exe'),
    args: ['-I', '-B', '-u', '-m', 'cybersoc_engine'],
  }),
  cwd: resources,
  spawnProcess: ((file, args, options) =>
    spawn(file, args, {
      ...options,
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.SystemRoot,
        PATH: join(process.env.SystemRoot!, 'System32'),
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PYTHONHOME: 'C:/invalid',
        PYTHONPATH: 'C:/invalid',
      },
    })) as typeof spawn,
  logger: { info: () => {}, error: () => {} },
});
try {
  const start = performance.now();
  const state = await engine.reconnect();
  const helloMs = performance.now() - start;
  assert.equal(state.status, 'connected');
  const result = await engine.scanFile(
    {
      jobId: 's11-benign',
      taskId: 'valid-pe',
      path: join(resources, 'runtime/vcruntime140.dll'),
      options: { maxBytes: 50 * 1024 * 1024 },
    },
    5_000,
  );
  assert.equal(result.status, 'SCANNED');
  assert(
    result.layers?.some(
      (layer) => layer.layer === 'PE' && layer.status === 'RAN',
    ),
  );
  const record = {
    state,
    helloMs,
    status: result.status,
    verdict: result.verdict,
    layers: result.layers,
    evidenceCodes: result.evidence.map((e) => e.code),
    label:
      'Motor privado instalado real; DLL benigna PE. PATH sin herramientas. No prueba Windows limpio ni red desconectada del SO.',
  };
  writeFileSync(process.argv[3]!, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
} finally {
  await engine.close();
}

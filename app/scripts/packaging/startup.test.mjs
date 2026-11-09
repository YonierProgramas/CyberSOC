import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

const resources = resolve(
  import.meta.dirname,
  '../../out/distribution/win-unpacked/resources',
);
const python = join(resources, 'runtime/python.exe');

test('package runtime: real hello within 5 s with external PATH and Python isolated', () => {
  assert(
    existsSync(python),
    'Primero prepara el runtime y ejecuta package:dir.',
  );
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: join(process.env.SystemRoot, 'System32'),
    PYTHONHOME: 'C:/cybersoc-no-existe',
    PYTHONPATH: 'C:/cybersoc-no-existe',
  };
  const hello = {
    jsonrpc: '2.0',
    id: 1,
    method: 'engine.hello',
    params: { protocol: '1', client: 'cybersoc-packaging-test/0.0.1' },
  };
  const start = performance.now();
  const result = spawnSync(
    python,
    ['-I', '-B', '-u', '-m', 'cybersoc_engine'],
    {
      cwd: resources,
      env,
      input: JSON.stringify(hello) + '\n',
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    },
  );
  const elapsedMs = Math.round(performance.now() - start);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, 1);
  assert.equal(response.result.protocol, '1');
  assert.match(response.result.python, /^3\.12\.16/);
  console.log('PRIVATE_ENGINE_HELLO', JSON.stringify({ elapsedMs, response }));
});

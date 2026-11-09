import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { resolveEnginePaths } from '../../src/main/engine-paths.ts';

// Selectively recovered from the Codex T6.2 draft (base 6d9394d).

test('package: paths independent of the clone, PATH and cwd inside ASAR', () => {
  const resources = join('C:/Portable con espacios', 'resources');
  const actual = resolveEnginePaths(
    join(resources, 'app.asar'),
    true,
    resources,
  );
  assert.equal(actual.command.file, join(resources, 'runtime/python.exe'));
  assert.equal(actual.cwd, resources);
  assert.equal(actual.root, join(resources, 'engine'));
  assert.deepEqual(actual.command.args, [
    '-I',
    '-B',
    '-u',
    '-m',
    'cybersoc_engine',
  ]);
  assert(!actual.command.file.includes('.venv'));
});
test('clean development: explicit src code, local venv, path as argument', () => {
  const root = 'C:/Demo con espacios/app';
  const actual = resolveEnginePaths(root, false, 'unused', 'win32');
  assert.equal(actual.cwd, root);
  assert.equal(
    actual.command.file,
    join(root, '../engine/.venv/Scripts/python.exe'),
  );
  assert.equal(actual.command.args.at(-1), join(root, '../engine/src'));
  assert(actual.command.args.includes('-B'));
});
test('Linux development keeps the venv binary in bin/', () => {
  assert.equal(
    resolveEnginePaths('/tmp/demo/app', false, 'unused', 'linux').command.file,
    join('/tmp/demo/engine', '.venv/bin/python'),
  );
});

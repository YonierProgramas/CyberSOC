import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyResources } from '../src/main/resource-integrity';

it('rejects altered manifest, altered file, extra and escape before execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'cybersoc-integrity-'));
  for (const directory of ['runtime', 'engine', 'notices'])
    mkdirSync(join(root, directory));
  const content = Buffer.from('fixture benigno');
  const hash = (value: Buffer) =>
    createHash('sha256').update(value).digest('hex');
  const path = join(root, 'runtime', 'fixture.txt');
  writeFileSync(path, content);
  const manifest = join(root, 'resources-manifest.json');
  const entries = [
    {
      path: 'runtime/fixture.txt',
      size: content.length,
      sha256: hash(content),
    },
  ];
  writeFileSync(manifest, JSON.stringify(entries));
  const digest = hash(readFileSync(manifest));
  expect(() => verifyResources(root, digest)).not.toThrow();
  expect(() => verifyResources(root, '0'.repeat(64))).toThrow('Manifiesto');
  writeFileSync(path, 'alterado');
  expect(() => verifyResources(root, digest)).toThrow('Recurso');
  writeFileSync(path, content);
  writeFileSync(join(root, 'engine', 'extra.py'), 'fixture');
  expect(() => verifyResources(root, digest)).toThrow('adicional');
  entries[0]!.path = 'runtime/../escape';
  writeFileSync(manifest, JSON.stringify(entries));
  expect(() => verifyResources(root, hash(readFileSync(manifest)))).toThrow(
    'inválida',
  );
});

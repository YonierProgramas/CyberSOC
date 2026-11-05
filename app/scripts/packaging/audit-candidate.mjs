import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const fuses = require('@electron/fuses');
const folder = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const entries = [];
function walk(relative = '') {
  for (const item of readdirSync(join(folder, relative), {
    withFileTypes: true,
  })) {
    const path = relative ? `${relative}/${item.name}` : item.name;
    assert(!item.isSymbolicLink(), 'No enlaces en candidato');
    if (item.isDirectory()) walk(path);
    else {
      const data = readFileSync(join(folder, path));
      entries.push({ path, size: data.length, sha256: sha(data) });
    }
  }
}
walk();
entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const archive = join(folder, 'resources', 'app.asar');
const files = asar
  .listPackage(archive)
  .map((path) => path.replaceAll('\\', '/'));
const main = asar
  .extractFile(archive, join('out', 'main', 'index.cjs'))
  .toString();
assert(
  !/CYBERSOC_EVIDENCE|EvidenceAIProvider|fake-evidence/.test(main),
  'Evidencia dentro de main',
);
assert(
  !files.some((path) =>
    /\/tests?\/|\/fixtures\/|instrumentation|\.map$/.test(path),
  ),
  'Fixtures/tests/maps incluidos',
);
assert(
  !entries.some((e) =>
    /\/ensurepip\/|\/venv\/|\/site-packages\/pip(?:\/|-)|\/tkinter\//.test(
      e.path,
    ),
  ),
  'Herramientas en runtime',
);
assert(
  !files.some((path) =>
    /\/(?:\.env|\.git)(?:\/|$)|\.sqlite$|cybersoc\.db/.test(path),
  ),
  'Datos privados incluidos',
);
const wire = await fuses.getCurrentFuseWire(
  join(folder, 'CyberSOC Defender.exe'),
);
for (const index of [0, 2, 3])
  assert.equal(wire[index], 48, 'Fuse debe estar apagado');
for (const index of [4, 5])
  assert.equal(wire[index], 49, 'Integridad/OnlyASAR deben estar activos');
const manifestData = readFileSync(
  join(folder, 'resources/resources-manifest.json'),
);
assert(
  main.includes(sha(manifestData)),
  'Digest del manifiesto no anclado en main',
);
const resources = JSON.parse(
  manifestData.toString('utf8').replace(/^\uFEFF/, ''),
);
for (const item of resources) {
  const path = join(folder, 'resources', item.path);
  assert(lstatSync(path).isFile());
  const data = readFileSync(path);
  assert.equal(data.length, item.size);
  assert.equal(sha(data), item.sha256);
}
const result = {
  version: JSON.parse(asar.extractFile(archive, 'package.json')).version,
  files: entries.length,
  size: entries.reduce((s, e) => s + e.size, 0),
  treeSha256: sha(
    Buffer.from(
      entries.map((e) => `${e.path}\0${e.size}\0${e.sha256}\n`).join(''),
    ),
  ),
  treeDefinition:
    'SHA256 UTF-8: rutas relativas / orden ordinal; ruta NUL tamaño NUL sha256 LF',
  fuses: wire,
  resourceManifestSha256: sha(manifestData),
  resources: resources.length,
  asarEntries: files.length,
  evidenceMode: false,
  dependencyFixtures: false,
  entries,
};
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, entries: undefined }));

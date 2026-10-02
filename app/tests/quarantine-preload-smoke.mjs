// Ejecutar después de npm run build. El sandbox de Electron no ofrece require('zod').
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

let exposed;
let invocation;
const source = await readFile(
  new URL('../out/preload/index.cjs', import.meta.url),
  'utf8',
);
runInNewContext(source, {
  require(name) {
    assert.equal(
      name,
      'electron',
      `Dependencia no disponible en el preload sandbox: ${name}`,
    );
    return {
      contextBridge: {
        exposeInMainWorld(name, api) {
          assert.equal(name, 'cybersoc');
          exposed = api;
        },
      },
      ipcRenderer: {
        async invoke(...args) {
          invocation = args;
        },
        on() {},
        removeListener() {},
      },
    };
  },
});
assert.ok(exposed?.quarantine);
await exposed.quarantine.restore('q1', { trustHash: false });
assert.deepEqual(invocation, [
  'quarantine:restore',
  'q1',
  { trustHash: false },
]);
assert.equal(exposed.ipcRenderer, undefined);
console.log(
  'OK: preload compilado ejecutable con solo Electron; API quarantine disponible.',
);

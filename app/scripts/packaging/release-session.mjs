// External launcher for native tests. It opens no inspector, test IPC or CDP.
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.argv[2]);
const profile = process.argv[3]
  ? resolve(process.argv[3])
  : mkdtempSync(join(tmpdir(), 'cybersoc-s11-release-á espacios-'));
const output = resolve(process.argv[4]);
if (!profile.includes('cybersoc-s11-'))
  throw new Error('Solo perfiles descartables.');
mkdirSync(profile, { recursive: true });
mkdirSync(output, { recursive: true });
const log = openSync(join(output, 'native-stderr.log'), 'a');
const env = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  PATH: join(process.env.SystemRoot, 'System32'),
  // Decoys: the release must ignore them. They hold no secrets or real data paths.
  CYBERSOC_EVIDENCE_MODE: '1',
  CYBERSOC_EVIDENCE_ROOT: join(profile, 'evidence-trap'),
  CYBERSOC_ENGINE_CMD: '["C:/cybersoc-invalid/python.exe"]',
  PYTHONHOME: 'C:/cybersoc-invalid',
  PYTHONPATH: 'C:/cybersoc-invalid',
  NODE_OPTIONS: '--require=C:/cybersoc-invalid.js',
  ELECTRON_RUN_AS_NODE: '1',
};
const child = spawn(exe, [`--user-data-dir=${profile}`], {
  env,
  cwd: profile,
  stdio: ['ignore', log, log],
  windowsHide: false,
  detached: false,
});
child.on('exit', (code) => console.log('RELEASE_EXIT', code));
const record = {
  exe,
  exeSha256: createHash('sha256').update(readFileSync(exe)).digest('hex'),
  profile,
  pid: child.pid,
  started: new Date().toISOString(),
  kind: 'RELEASE NATIVO ENDURECIDO, sin inspector ni modo evidencia',
};
writeFileSync(
  join(output, 'native-session.json'),
  JSON.stringify(record, null, 2),
);
console.log(JSON.stringify(record));

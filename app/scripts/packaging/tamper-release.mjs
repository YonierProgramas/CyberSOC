import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const useInstalled = process.argv[4] === '--installed-disposable';
if (useInstalled && !source.includes('cybersoc-s11-instalación'))
  throw new Error('Solo instalación descartable S11');
const copy = useInstalled
  ? source
  : resolve(import.meta.dirname, '../../out/cybersoc-s11-tamper-' + Date.now());
if (!useInstalled) cpSync(source, copy, { recursive: true });
mkdirSync(output, { recursive: true });
const exe = join(copy, 'CyberSOC Defender.exe');
async function probe(label, positive = false) {
  const profile = copy + '-profile-' + Date.now() + '-' + label;
  mkdirSync(profile);
  const child = spawn(exe, [`--user-data-dir=${profile}`], {
    cwd: profile,
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.SystemRoot,
      USERPROFILE: process.env.USERPROFILE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PATH: join(process.env.SystemRoot, 'System32'),
    },
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b));
  child.stdout.resume();
  const end = Date.now() + (positive ? 15000 : 6000);
  while (Date.now() < end && child.exitCode === null) {
    if (positive && existsSync(join(profile, 'distribution-profile.json')))
      break;
    await delay(100);
  }
  const beforeStop = child.exitCode;
  if (child.exitCode === null) {
    try {
      execFileSync(
        join(process.env.SystemRoot, 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'pipe', windowsHide: true },
      );
    } catch {}
  }
  await delay(100);
  const databaseCreated = existsSync(join(profile, 'cybersoc.db'));
  writeFileSync(
    join(output, label + '-probe.json'),
    JSON.stringify({ profile, beforeStop, databaseCreated, stderr }, null, 2),
  );
  assert.equal(
    databaseCreated,
    positive,
    label + ': estado de datos inesperado',
  );
  return {
    label,
    beforeStop,
    databaseCreated,
    stderr,
    observation: positive
      ? 'Arranque y base creados'
      : 'Sin base tras 6 segundos; GUI puede esperar cierre de diálogo, no se exige stderr',
  };
}
const records = [await probe('control', true)];
const manifest = join(copy, 'resources/resources-manifest.json');
const originalManifest = readFileSync(manifest);
const notice = join(copy, 'resources/notices/THIRD-PARTY-NOTICES.txt');
const originalNotice = readFileSync(notice);
const archive = join(copy, 'resources/app.asar');
const originalAsar = readFileSync(archive);
try {
  const changed = Buffer.concat([
    originalNotice,
    Buffer.from('\nBenign tamper fixture\n'),
  ]);
  writeFileSync(notice, changed);
  const inventory = JSON.parse(
    originalManifest.toString('utf8').replace(/^\uFEFF/, ''),
  );
  const entry = inventory.find(
    (e) => e.path === 'notices/THIRD-PARTY-NOTICES.txt',
  );
  entry.size = changed.length;
  entry.sha256 = createHash('sha256').update(changed).digest('hex');
  writeFileSync(manifest, JSON.stringify(inventory));
  records.push(await probe('resource-and-manifest'));
  writeFileSync(manifest, originalManifest);
  writeFileSync(notice, originalNotice);
  const data = readFileSync(archive);
  data[24] ^= 1;
  writeFileSync(archive, data);
  records.push(await probe('asar-header'));
} finally {
  writeFileSync(manifest, originalManifest);
  writeFileSync(notice, originalNotice);
  writeFileSync(archive, originalAsar);
}
writeFileSync(
  join(output, 'tamper-results.json'),
  JSON.stringify({ source, copy, records }, null, 2),
);
console.log(
  JSON.stringify(
    records.map((r) => ({
      label: r.label,
      exit: r.beforeStop,
      databaseCreated: r.databaseCreated,
      diagnostic: r.stderr.slice(0, 250),
    })),
  ),
);

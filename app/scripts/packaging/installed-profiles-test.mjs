import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
const app = resolve(import.meta.dirname, '../..');
const exe = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const root = join(app, 'out', 'cybersoc-s11-matriz-' + Date.now());
mkdirSync(root);
mkdirSync(evidence, { recursive: true });
const records = [];
function fixture(name, version) {
  const profile = join(root, name);
  execFileSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--import',
      './tests/history-register.mjs',
      join(app, 'scripts/packaging/fixture-profile.ts'),
      profile,
      String(version),
    ],
    { cwd: app, windowsHide: true, stdio: 'pipe' },
  );
  return profile;
}
function snapshot(profile) {
  const db = new DatabaseSync(join(profile, 'cybersoc.db'), { readOnly: true });
  const counts = {};
  for (const table of [
    'schema_migrations',
    'scan_jobs',
    'scan_results',
    'ai_conversations',
    'ai_messages',
    'ai_message_cards',
  ]) {
    if (!db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table))
      continue;
    const rows = db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
    counts[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(rows.join('\n')).digest('hex'),
    };
  }
  assert.equal(
    db.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const keep = db
    .prepare("SELECT value_json FROM settings WHERE key='fixture.preserve'")
    .get();
  db.close();
  return {
    counts,
    keep,
    backups:
      existsSync(join(profile, 'backups')) &&
      lstatSync(join(profile, 'backups')).isDirectory()
        ? readdirSync(join(profile, 'backups')).filter((x) =>
            existsSync(join(profile, 'backups', x, 'verified.json')),
          )
        : [],
  };
}
function launch(profile) {
  mkdirSync(profile, { recursive: true });
  const child = spawn(exe, [`--user-data-dir=${profile}`], {
    cwd: profile,
    windowsHide: false,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      PATH: join(process.env.SystemRoot, 'System32'),
      CYBERSOC_EVIDENCE_MODE: '1',
      CYBERSOC_EVIDENCE_ROOT: join(profile, 'evidence-trap'),
      PYTHONHOME: 'C:/invalid',
      PYTHONPATH: 'C:/invalid',
    },
  });
  let stderr = '';
  child.stderr.on('data', (data) => (stderr += data));
  child.stdout.resume();
  return { child, stderr: () => stderr };
}
async function stop(run) {
  if (run.child.exitCode === null) {
    try {
      execFileSync(
        join(process.env.SystemRoot, 'System32/taskkill.exe'),
        ['/PID', String(run.child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'pipe' },
      );
    } catch {}
  }
  await delay(250);
}
async function ready(run, profile) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (run.child.exitCode !== null)
      throw new Error('Salida prematura: ' + run.stderr());
    if (existsSync(join(profile, 'distribution-profile.json'))) {
      await delay(1200);
      assert.equal(run.child.exitCode, null);
      return;
    }
    await delay(100);
  }
  throw new Error('Sin marcador de arranque: ' + run.stderr());
}
async function positive(name, profile, before) {
  const first = launch(profile);
  try {
    await ready(first, profile);
  } finally {
    await stop(first);
  }
  const after = snapshot(profile);
  assert.equal(after.counts.schema_migrations.count, 7);
  if (before) {
    for (const table of [
      'scan_jobs',
      'ai_conversations',
      'ai_messages',
      'ai_message_cards',
    ])
      if (before.counts[table])
        assert.deepEqual(after.counts[table], before.counts[table]);
    assert.equal(
      after.counts.scan_results.count,
      before.counts.scan_results.count,
    );
    assert.deepEqual(after.keep, before.keep);
  }
  const second = launch(profile);
  try {
    await ready(second, profile);
    const duplicate = launch(profile);
    await Promise.race([
      new Promise((resolve) => duplicate.child.once('exit', resolve)),
      delay(5000),
    ]);
    assert.equal(duplicate.child.exitCode, 0, 'Segunda instancia debe salir');
  } finally {
    await stop(second);
  }
  const restart = snapshot(profile);
  for (const table of [
    'scan_jobs',
    'ai_conversations',
    'ai_messages',
    'ai_message_cards',
  ])
    if (after.counts[table])
      assert.deepEqual(restart.counts[table], after.counts[table]);
  assert.deepEqual(restart.backups, after.backups);
  assert(!existsSync(join(profile, 'evidence-trap')));
  records.push({
    name,
    profile,
    before,
    after,
    restart,
    shutdown:
      'Terminación de prueba; reinicio con WAL, no cierre nativo normal',
  });
}
await positive('limpio', join(root, 'limpio á espacios'));
for (const version of [6, 7]) {
  const profile = fixture('schema00' + version + ' á', version);
  await positive('upgrade00' + version, profile, snapshot(profile));
}
for (const kind of ['backup', 'migration']) {
  const profile = fixture('fallo-' + kind, 6);
  if (kind === 'backup')
    writeFileSync(join(profile, 'backups'), 'fixture bloquea backup');
  else {
    const db = new DatabaseSync(join(profile, 'cybersoc.db'));
    db.exec(
      "CREATE TRIGGER fail007 BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END",
    );
    db.close();
  }
  const before = snapshot(profile);
  const run = launch(profile);
  await Promise.race([
    new Promise((resolve) => run.child.once('exit', resolve)),
    delay(15000),
  ]);
  await stop(run);
  const after = snapshot(profile);
  assert.equal(after.counts.schema_migrations.count, 6);
  assert.deepEqual(after.counts.scan_jobs, before.counts.scan_jobs);
  assert.deepEqual(after.counts.ai_messages, before.counts.ai_messages);
  assert(!existsSync(join(profile, 'distribution-profile.json')));
  assert(run.stderr().includes('No se pudo iniciar'));
  records.push({
    name: 'fallo-' + kind,
    profile,
    before,
    after,
    stderr: run.stderr(),
  });
  if (kind === 'migration') {
    const restored = join(root, 'recuperado compatible');
    mkdirSync(restored);
    copyFileSync(
      join(profile, 'backups', after.backups[0], 'cybersoc.db'),
      join(restored, 'cybersoc.db'),
    );
    const db = new DatabaseSync(join(restored, 'cybersoc.db'));
    db.exec('DROP TRIGGER fail007');
    db.close();
    await positive(
      'recuperación compatible: retirada solo la inyección de fallo sintética',
      restored,
      snapshot(restored),
    );
  }
}
writeFileSync(
  join(evidence, 'installed-profiles.json'),
  JSON.stringify(
    {
      exe,
      exeSha256: createHash('sha256').update(readFileSync(exe)).digest('hex'),
      root,
      records,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    records.map((r) => ({
      name: r.name,
      profile: r.profile,
      counts: r.after.counts,
      backups: r.after.backups.length,
    })),
  ),
);

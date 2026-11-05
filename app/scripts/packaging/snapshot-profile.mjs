import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
if (!root.includes('cybersoc-s11-'))
  throw new Error('Solo perfil descartable.');
const db = new DatabaseSync(join(root, 'cybersoc.db'), { readOnly: true });
const tables = [
  'schema_migrations',
  'scan_jobs',
  'scan_results',
  'ai_conversations',
  'ai_messages',
  'ai_message_cards',
  'settings',
];
const counts = {};
for (const table of tables) {
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
const record = {
  profile: root,
  integrity: db.prepare('PRAGMA integrity_check').all(),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
  counts,
  backups: existsSync(join(root, 'backups'))
    ? readdirSync(join(root, 'backups')).map((name) => ({
        name,
        verified: existsSync(join(root, 'backups', name, 'verified.json')),
      }))
    : [],
  evidenceTrapExists: existsSync(join(root, 'evidence-trap')),
  marker: existsSync(join(root, 'distribution-profile.json'))
    ? JSON.parse(readFileSync(join(root, 'distribution-profile.json'), 'utf8'))
    : null,
};
db.close();
writeFileSync(process.argv[3], JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));

// Packaging tests only: disposable synthetic profiles, never real profiles.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import { initialMigration } from '../../src/core/persistence/migrations/001_init';
import { scansMigration } from '../../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../../src/core/persistence/migrations/003_evidence_ai';
import { zonesMigration } from '../../src/core/persistence/migrations/004_zones';
import { quarantineMigration } from '../../src/core/persistence/migrations/005_quarantine';
import { conversationsMigration } from '../../src/core/persistence/migrations/006_conversations';
import { assistantCardsMigration } from '../../src/core/persistence/migrations/007_assistant_cards';
import { ConversationRepository } from '../../src/core/persistence/ConversationRepository';
import { seedHistory, seedMessages } from '../../tests/fixtures/history';

const root = resolve(process.argv[2]!);
const version = Number(process.argv[3]);
if (!root.includes('cybersoc-s11-') || ![6, 7].includes(version))
  throw new Error('Solo perfil descartable S11.');
mkdirSync(root, { recursive: true });
const db = new Database(join(root, 'cybersoc.db'));
try {
  new MigrationRunner(db, [
    initialMigration,
    scansMigration,
    evidenceAiMigration,
    zonesMigration,
    quarantineMigration,
    conversationsMigration,
    ...(version === 7 ? [assistantCardsMigration] : []),
  ]).run();
  seedHistory(db, 3, 12);
  db.exec("UPDATE scan_jobs SET status='COMPLETED', finished_at=created_at");
  if (version === 7) seedMessages(db, 12);
  else {
    const repository = new ConversationRepository(db);
    const conversation = repository.create('Historia sintética 006');
    repository.append(conversation.id, [
      { role: 'user', content: 'Pregunta sintética' },
      { role: 'assistant', content: 'Respuesta guardada sin IA real' },
    ]);
  }
  db.prepare('INSERT INTO settings VALUES(?,?,?)').run(
    'fixture.preserve',
    '{"synthetic":"keep"}',
    '2026-11-05T00:00:00Z',
  );
  writeFileSync(join(root, '.cybersoc-s11-fixture'), `schema ${version}`);
} finally {
  db.close();
}

import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import { ConversationRepository } from '../../src/core/persistence/ConversationRepository';
import { emptyCard, seedHistory } from '../fixtures/history';

/**
 * Synthetic SQLite profile with the seven migrations, generated on each run.
 * Reproduces in code the content that fixes E-01…E-10 copied from
 * construccion/…/10B-datos/20-007-sintetico.sqlite, which is not part of the repository
 * and therefore did not exist in CI:
 * - 45 jobs with 90 seedHistory results, all COMPLETED, AI NOT_REQUIRED;
 * - «Legado sintético006»: 12 questions and 12 answers without a card;
 * - «Prueba sintética IPC B»: 2 questions and 2 answers with a registered card.
 * The dates of the two chats are fixed and earlier than the 45 chats the test adds,
 * so the archive keeps its order. Fake rows only: no user files.
 */
export function buildSyntheticProfile(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    new MigrationRunner(db).run();
    seedHistory(db, 45, 90);
    db.exec(
      "UPDATE scan_jobs SET status='COMPLETED', finished_at=created_at; UPDATE scan_results SET ai_status='NOT_REQUIRED'",
    );
    const repo = new ConversationRepository(db);
    const legacy = repo.create('Legado sintético006').id;
    repo.append(
      legacy,
      Array.from({ length: 12 }, (_, i) => [
        { role: 'user' as const, content: `P${i}` },
        { role: 'assistant' as const, content: `R${i}`, model: 'fake-006' },
      ]).flat(),
    );
    const current = repo.create('Prueba sintética IPC B').id;
    for (const question of [
      'Prueba sintética IPC B',
      'Segunda pregunta sintética',
    ]) {
      repo.append(current, [{ role: 'user', content: question }]);
      repo.appendAnsweredWithCard(
        current,
        {
          content: 'Demostración con FakeAIProvider: respuesta sintética.',
          model: 'fake-evidence-v1',
        },
        emptyCard(),
      );
    }
    const dated = db.prepare(
      'UPDATE ai_conversations SET created_at = ?, updated_at = ? WHERE id = ?',
    );
    const messages = db.prepare(
      'UPDATE ai_messages SET created_at = ? WHERE conversation_id = ?',
    );
    dated.run('2026-11-04T15:31:32.141Z', '2026-11-04T15:31:32.145Z', legacy);
    messages.run('2026-11-04T15:31:32.145Z', legacy);
    dated.run('2026-11-04T15:31:34.080Z', '2026-11-04T15:31:34.129Z', current);
    messages.run('2026-11-04T15:31:34.100Z', current);
  } finally {
    db.close();
  }
}

import { Database } from '../../src/core/persistence/Database';
import { MigrationRunner } from '../../src/core/persistence/MigrationRunner';
import { ConversationRepository } from '../../src/core/persistence/ConversationRepository';
import { emptyCard, seedHistory } from '../fixtures/history';

/**
 * Perfil SQLite sintético con las siete migraciones, generado en cada ejecución.
 * Reproduce en código el contenido que las correcciones E-01…E-10 copiaban de
 * construccion/…/10B-datos/20-007-sintetico.sqlite, que no forma parte del repositorio
 * y por eso no existía en CI:
 * - 45 trabajos con 90 resultados de seedHistory, todos COMPLETED, IA NOT_REQUIRED;
 * - «Legado sintético006»: 12 preguntas y 12 respuestas sin tarjeta;
 * - «Prueba sintética IPC B»: 2 preguntas y 2 respuestas con tarjeta registrada.
 * Las fechas de los dos chats son fijas y anteriores a los 45 chats que añade la prueba,
 * para que el archivo conserve su orden. Solo filas ficticias: sin archivos del usuario.
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

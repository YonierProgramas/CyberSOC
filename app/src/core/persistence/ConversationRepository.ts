import { randomUUID } from 'node:crypto';
import type {
  ConversationDTO,
  ConversationMessageDTO,
  ConversationQuery,
} from '../../shared/ipc';
import type { Database } from './Database';

export interface NewConversationMessage {
  role: ConversationMessageDTO['role'];
  content: string;
  toolCallsJson?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

const conversationColumns =
  'id, title, created_at AS createdAt, updated_at AS updatedAt';
const messageColumns = `id, conversation_id AS conversationId, role, content,
  tool_calls_json AS toolCallsJson, model, input_tokens AS inputTokens,
  output_tokens AS outputTokens, created_at AS createdAt`;

/** Historial completo en SQLite; rowid desempata mensajes con la misma fecha. */
export class ConversationRepository {
  constructor(private readonly db: Database) {}

  create(title: string | null = null): ConversationDTO {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ai_conversations
      (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }

  get(id: string): ConversationDTO | undefined {
    return this.db
      .prepare(
        `SELECT ${conversationColumns} FROM ai_conversations WHERE id = ?`,
      )
      .get(id) as unknown as ConversationDTO | undefined;
  }

  list(query: ConversationQuery = {}): ConversationDTO[] {
    const { limit = 50, offset = 0 } = query;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new RangeError('Paginación inválida.');
    return this.db
      .prepare(
        `SELECT ${conversationColumns} FROM ai_conversations
      ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as ConversationDTO[];
  }

  /** El lote de mensajes y updated_at se confirman juntos o se revierten juntos. */
  append(id: string, messages: readonly NewConversationMessage[]): void {
    this.db.transaction(() => {
      if (!this.get(id)) throw new Error('La conversación no existe.');
      if (messages.length === 0) return;
      const now = new Date().toISOString();
      const insert = this.db.prepare(`INSERT INTO ai_messages
        (id, conversation_id, role, content, tool_calls_json, model,
         input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const message of messages) {
        if (message.toolCallsJson != null) JSON.parse(message.toolCallsJson);
        for (const tokens of [message.inputTokens, message.outputTokens]) {
          if (tokens != null && (!Number.isSafeInteger(tokens) || tokens < 0))
            throw new RangeError('Conteo de tokens inválido.');
        }
        insert.run(
          randomUUID(),
          id,
          message.role,
          message.content,
          message.toolCallsJson ?? null,
          message.model ?? null,
          message.inputTokens ?? null,
          message.outputTokens ?? null,
          now,
        );
      }
      this.db
        .prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?')
        .run(now, id);
    });
  }

  /** Últimos turnos de usuario, incluidos sus mensajes de herramientas, en orden de llegada. */
  recentMessages(id: string, turns = 10): ConversationMessageDTO[] {
    if (!Number.isSafeInteger(turns) || turns < 1 || turns > 10)
      throw new RangeError('La ventana admite entre 1 y 10 turnos.');
    if (!this.get(id)) throw new Error('La conversación no existe.');
    return this.db
      .prepare(
        `SELECT ${messageColumns} FROM ai_messages
      WHERE conversation_id = ? AND rowid >= (
        SELECT MIN(rowid) FROM (
          SELECT rowid FROM ai_messages WHERE conversation_id = ? AND role = 'user'
          ORDER BY rowid DESC LIMIT ?
        )
      ) ORDER BY rowid`,
      )
      .all(id, id, turns) as unknown as ConversationMessageDTO[];
  }

  /** Diez pares completos: los intentos sin respuesta no expulsan contexto válido. */
  recentCompletedTurns(id: string): { question: string; answer: string }[] {
    if (!this.get(id)) throw new Error('La conversación no existe.');
    // LEAD delimita cada pregunta hasta la siguiente. La última respuesta sin
    // tool_calls es la respuesta final; los mensajes intermedios no son turnos.
    const rows = this.db
      .prepare(
        `
      WITH turns AS (
        SELECT rowid AS start, LEAD(rowid) OVER (ORDER BY rowid) AS next,
          content AS question
        FROM ai_messages WHERE conversation_id = ? AND role = 'user'
      ), completed AS (
        SELECT start, question, (
          SELECT content FROM ai_messages
          WHERE conversation_id = ? AND role = 'assistant' AND tool_calls_json IS NULL
            AND rowid > turns.start AND (turns.next IS NULL OR rowid < turns.next)
          ORDER BY rowid DESC LIMIT 1
        ) AS answer FROM turns
      )
      SELECT question, answer FROM completed WHERE answer IS NOT NULL
      ORDER BY start DESC LIMIT 10
    `,
      )
      .all(id, id) as unknown as { question: string; answer: string }[];
    return rows.reverse();
  }
}

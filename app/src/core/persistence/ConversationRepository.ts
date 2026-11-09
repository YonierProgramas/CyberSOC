import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_CARD_SCHEMA_V1,
  ASSISTANT_CARD_MAX_BYTES,
} from '../../shared/ipc';
import { assistantCardV1Schema } from '../../shared/assistant-card-schemas';
import { conversationPageQuerySchema } from '../../shared/history-schemas';
import type {
  ConversationDTO,
  ConversationMessageDTO,
  ConversationQuery,
  ConversationPageQuery,
  ConversationSummaryDTO,
  Page,
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

/** Complete history in SQLite; rowid breaks ties between messages with the same date. */
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
      throw new RangeError('Invalid pagination.');
    return this.db
      .prepare(
        `SELECT ${conversationColumns} FROM ai_conversations
      ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as ConversationDTO[];
  }

  /** The message batch and updated_at are committed or rolled back together. */
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
            throw new RangeError('Invalid token count.');
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

  /** Final message and card share a COMMIT; the caller only advances the Queue afterwards. */
  appendAnsweredWithCard(
    id: string,
    message: Omit<NewConversationMessage, 'role' | 'toolCallsJson'>,
    card: unknown,
    byteLimit = ASSISTANT_CARD_MAX_BYTES,
  ): string {
    if (
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 1 ||
      byteLimit > ASSISTANT_CARD_MAX_BYTES
    )
      throw new RangeError('Invalid card limit.');
    let json: string | undefined;
    try {
      json = JSON.stringify(card);
    } catch {
      /* A non-serializable card stays OMITTED. */
    }
    const bytes = json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
    const valid = assistantCardV1Schema.safeParse(card).success;
    const reason =
      !valid || json === undefined
        ? 'INVALID'
        : bytes > byteLimit
          ? 'TOO_LARGE'
          : null;
    for (const tokens of [message.inputTokens, message.outputTokens])
      if (tokens != null && (!Number.isSafeInteger(tokens) || tokens < 0))
        throw new RangeError('Invalid token count.');
    const savedId = this.db.transaction(() => {
      if (!this.get(id)) throw new Error('La conversación no existe.');
      const messageId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO ai_messages (id, conversation_id, role, content, tool_calls_json, model, input_tokens, output_tokens, created_at)
        VALUES (?, ?, 'assistant', ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          id,
          message.content,
          message.model ?? null,
          message.inputTokens ?? null,
          message.outputTokens ?? null,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO ai_message_cards (message_id, schema, state, card_json, omitted_reason, byte_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          ASSISTANT_CARD_SCHEMA_V1,
          reason ? 'OMITTED' : 'STORED',
          reason ? null : json!,
          reason,
          bytes,
          now,
        );
      this.db
        .prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?')
        .run(now, id);
      return messageId;
    });
    if (reason)
      console.warn('Tarjeta del asistente omitida.', {
        messageId: savedId,
        reason,
        bytes,
      });
    return savedId;
  }

  listPage(input: ConversationPageQuery): Page<ConversationSummaryDTO> {
    const query = conversationPageQuerySchema.parse(input);
    return this.db.readTransaction(() => ({
      items: this.list(query).map((conversation) => {
        const counts = this.db
          .prepare(
            `SELECT COUNT(CASE WHEN role IN ('user','assistant') THEN 1 END) messageCount,
          MAX(created_at) lastMessageAt FROM ai_messages WHERE conversation_id=?`,
          )
          .get(conversation.id)!;
        return {
          ...conversation,
          messageCount: Number(counts.messageCount),
          lastMessageAt: counts.lastMessageAt as string | null,
        };
      }),
      total: Number(
        this.db.prepare('SELECT COUNT(*) total FROM ai_conversations').get()!
          .total,
      ),
      offset: query.offset,
      limit: query.limit,
    }));
  }

  /** Latest user turns, including their tool messages, in arrival order. */
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

  /** Ten complete pairs: attempts without a response do not evict valid context. */
  recentCompletedTurns(id: string): { question: string; answer: string }[] {
    if (!this.get(id)) throw new Error('La conversación no existe.');
    // LEAD delimits each question up to the next one. The last response without
    // tool_calls is the final response; intermediate messages are not turns.
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

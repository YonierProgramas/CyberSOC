import type { Database } from './Database';
import {
  ASSISTANT_CARD_MAX_BYTES,
  ASSISTANT_PAGE_MAX_CARD_BYTES,
  type ArchivedActionStateDTO,
  type AssistantCardV1,
  type AssistantToolCallDTO,
  type ConversationHistoryItemDTO,
  type ConversationMessagesPageDTO,
  type ConversationMessagesQuery,
} from '../../shared/ipc';
import { assistantCardV1Schema } from '../../shared/assistant-card-schemas';
import { messagesQuerySchema } from '../../shared/history-schemas';

interface Metadata {
  rowid: number;
  id: string;
  cardBytes: number;
}
interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallsJson: string | null;
  model: string | null;
  createdAt: string;
}

/** Independent assistant archive: it knows nothing about Queue, reset, ask, tools or provider. */
export class ConversationArchiveReader {
  constructor(
    private readonly db: Database,
    private readonly reportAvailable: (id: string) => boolean = () => false,
  ) {}

  listMessages(input: ConversationMessagesQuery): ConversationMessagesPageDTO {
    const query = messagesQuerySchema.parse(input);
    const limit = query.limit ?? 30;
    return this.db.readTransaction(() => {
      if (
        !this.db
          .prepare('SELECT id FROM ai_conversations WHERE id=?')
          .get(query.conversationId)
      )
        throw new Error('No existe la conversación.');
      const cursor = query.before
        ? this.db
            .prepare(
              'SELECT rowid FROM ai_messages WHERE id=? AND conversation_id=?',
            )
            .get(query.before, query.conversationId)
        : undefined;
      if (query.before && !cursor) throw new Error('Cursor inválido.');
      const total = Number(
        this.db
          .prepare(
            'SELECT COUNT(*) total FROM ai_messages WHERE conversation_id=?',
          )
          .get(query.conversationId)!.total,
      );
      // Lengths/IDs only first (≤101 rows): never materialize 100 large cards
      // just to find out they exceed the budget. The index keeps rowid order.
      const metadata = this.db
        .prepare(
          `SELECT m.rowid, m.id, COALESCE(length(CAST(c.card_json AS BLOB)),0) cardBytes
        FROM ai_messages m LEFT JOIN ai_message_cards c ON c.message_id=m.id
        WHERE m.conversation_id=? ${cursor ? 'AND m.rowid < ?' : ''}
        ORDER BY m.rowid DESC LIMIT ?`,
        )
        .all(
          query.conversationId,
          ...(cursor ? [Number(cursor.rowid)] : []),
          limit + 1,
        ) as unknown as Metadata[];
      // Array: always a contiguous prefix of the descending read, with no gaps.
      // push O(1) amortizado; recorrido/reverse O(p), p ≤ 100; tarjetas ≤ 8 MiB.
      const selected: Metadata[] = [];
      let bytes = 0;
      for (const item of metadata.slice(0, limit)) {
        if (
          selected.length &&
          bytes + item.cardBytes > ASSISTANT_PAGE_MAX_CARD_BYTES
        )
          break;
        selected.push(item);
        bytes += item.cardBytes;
      }
      const items = selected
        .map((item) => this.readMessage(query.conversationId, item))
        .reverse();
      return {
        conversationId: query.conversationId,
        items,
        olderCursor:
          metadata.length > selected.length ? selected.at(-1)!.id : null,
        total,
      };
    });
  }

  private readMessage(
    conversationId: string,
    metadata: Metadata,
  ): ConversationHistoryItemDTO {
    const row = this.db
      .prepare(
        `SELECT id, role, content, tool_calls_json toolCallsJson, model, created_at createdAt
      FROM ai_messages WHERE id=? AND conversation_id=?`,
      )
      .get(metadata.id, conversationId) as unknown as MessageRow;
    const base = { id: row.id, createdAt: row.createdAt };
    if (row.role === 'user') {
      const answered = this.db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM ai_messages WHERE conversation_id=?
        AND role='assistant' AND tool_calls_json IS NULL AND rowid > ? AND rowid < COALESCE(
          (SELECT MIN(rowid) FROM ai_messages WHERE conversation_id=? AND role='user' AND rowid > ?), 9223372036854775807)) answered`,
        )
        .get(
          conversationId,
          metadata.rowid,
          conversationId,
          metadata.rowid,
        )!.answered;
      return {
        ...base,
        kind: 'USER',
        text: row.content,
        answered: Boolean(answered),
      };
    }
    if (row.role === 'tool' || row.toolCallsJson !== null)
      return {
        ...base,
        kind: 'TOOLS',
        tools: this.publicTools(row.toolCallsJson),
      };
    const record = this.db
      .prepare(
        `SELECT schema, state, omitted_reason FROM ai_message_cards WHERE message_id=?`,
      )
      .get(row.id);
    const assistant = {
      ...base,
      kind: 'ASSISTANT' as const,
      text: row.content,
      model: row.model,
    };
    if (!record)
      return {
        ...assistant,
        cardState: 'NOT_RECORDED',
        card: null,
        actionStates: [],
      };
    if (
      record.state !== 'STORED' ||
      metadata.cardBytes > ASSISTANT_CARD_MAX_BYTES
    )
      return {
        ...assistant,
        cardState: 'OMITTED',
        card: null,
        actionStates: [],
      };
    const json = this.db
      .prepare('SELECT card_json FROM ai_message_cards WHERE message_id=?')
      .get(row.id)!.card_json;
    let card: AssistantCardV1;
    try {
      card = assistantCardV1Schema.parse(JSON.parse(String(json)));
    } catch {
      return {
        ...assistant,
        cardState: 'OMITTED',
        card: null,
        actionStates: [],
      };
    }
    return {
      ...assistant,
      cardState: 'RECORDED',
      card,
      actionStates: this.actionStates(card),
    };
  }

  private publicTools(json: string | null): AssistantToolCallDTO[] {
    if (json === null) return [];
    const calls: unknown = JSON.parse(json);
    if (!Array.isArray(calls) || calls.length > 60)
      throw new Error('Herramientas inválidas.');
    return calls.map(
      (call: { name?: unknown; ok?: unknown; code?: unknown }) => {
        if (!call || typeof call.name !== 'string' || call.name.length > 64)
          throw new Error('Herramienta inválida.');
        const code =
          typeof call.ok !== 'boolean'
            ? 'NOT_RECORDED'
            : typeof call.code === 'string'
              ? call.code
              : null;
        if (code !== null && code.length > 32)
          throw new Error('Código inválido.');
        // Allowlist: never return content, input, path, hash or original JSON.
        return { name: call.name, ok: call.ok === true, code };
      },
    );
  }

  private actionStates(card: AssistantCardV1): ArchivedActionStateDTO[] {
    return card.suggestedActions.map((action, index) => {
      const base = { index, ...action };
      if (action.action === 'RUN_SCAN_PLAN')
        return { ...base, availability: 'HISTORY_READ_ONLY' };
      if (action.action === 'OPEN_QUARANTINE')
        return { ...base, availability: 'AVAILABLE' };
      if (action.action === 'EXPORT_REPORT')
        return {
          ...base,
          availability:
            action.targetId && this.reportAvailable(action.targetId)
              ? 'AVAILABLE'
              : 'EXPIRED',
        };
      const result = action.targetId
        ? this.db
            .prepare('SELECT verdict FROM scan_results WHERE id=?')
            .get(action.targetId)
        : undefined;
      if (!result) return { ...base, availability: 'MISSING' };
      if (
        action.action === 'QUARANTINE' &&
        result.verdict !== 'DETECTED' &&
        result.verdict !== 'SUSPICIOUS'
      )
        return { ...base, availability: 'NOT_APPLICABLE' };
      // Availability indicator, never durable authorization: on click it goes back
      // to the existing flow (AI settings / QuarantineManager / confirmation).
      return { ...base, availability: 'AVAILABLE' };
    });
  }
}

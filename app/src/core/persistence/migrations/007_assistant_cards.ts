import type { Migration } from '../MigrationRunner';

export const assistantCardsMigration: Migration = {
  version: 7,
  name: '007_assistant_cards',
  up(database) {
    database.exec(`
CREATE TABLE ai_message_cards (
  message_id TEXT PRIMARY KEY REFERENCES ai_messages(id) ON DELETE CASCADE,
  schema TEXT NOT NULL CHECK (schema = 'cybersoc.assistant-card/v1'),
  state TEXT NOT NULL CHECK (state IN ('STORED', 'OMITTED')),
  card_json TEXT CHECK (card_json IS NULL OR
    (json_valid(card_json) AND length(CAST(card_json AS BLOB)) <= 2097152)),
  omitted_reason TEXT CHECK (omitted_reason IS NULL OR omitted_reason IN ('TOO_LARGE', 'INVALID')),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TEXT NOT NULL,
  CHECK ((state = 'STORED' AND card_json IS NOT NULL AND omitted_reason IS NULL) OR
    (state = 'OMITTED' AND card_json IS NULL AND omitted_reason IS NOT NULL))
);
CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id);
`);
  },
};

import type { Migration } from '../MigrationRunner';

export const conversationsMigration: Migration = {
  version: 6,
  name: '006_conversations',
  up(database) {
    database.exec(`
CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_calls_json TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
  created_at TEXT NOT NULL
);
`);
  },
};

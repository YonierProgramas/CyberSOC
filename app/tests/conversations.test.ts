import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../src/core/persistence/migrations/003_evidence_ai';
import { zonesMigration } from '../src/core/persistence/migrations/004_zones';
import { quarantineMigration } from '../src/core/persistence/migrations/005_quarantine';
import { ConversationRepository } from '../src/core/persistence/ConversationRepository';
import { AssistantOrchestrator } from '../src/core/ai/AssistantOrchestrator';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import type { AIResult, AssistantTurnRequest } from '../src/core/ai/AIProvider';

let root: string;
let db: Database;
let repo: ConversationRepository;
const config = appConfigSchema.parse({});
function makeAssistant(provider: FakeAIProvider | null = new FakeAIProvider()) {
  return new AssistantOrchestrator({
    db,
    provider: () => provider,
    readConfig: () => config,
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cybersoc-conversations-'));
  db = new Database(join(root, 'test.db'));
  new MigrationRunner(db).run();
  repo = new ConversationRepository(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Migración 006 y ConversationRepository con BD temporal', () => {
  it('migra desde 005 sin perder datos y es idempotente', () => {
    const old = new Database(join(root, 'old.db'));
    try {
      new MigrationRunner(old, [
        initialMigration,
        scansMigration,
        evidenceAiMigration,
        zonesMigration,
        quarantineMigration,
      ]).run();
      old
        .prepare('INSERT INTO settings VALUES (?, ?, ?)')
        .run('existing', '{}', 'before');
      expect(new MigrationRunner(old).run()).toEqual([6]);
      expect(new MigrationRunner(old).run()).toEqual([]);
      expect(old.prepare('SELECT * FROM settings').all()).toEqual([
        { key: 'existing', value_json: '{}', updated_at: 'before' },
      ]);
      expect(
        old
          .prepare('PRAGMA table_info(ai_messages)')
          .all()
          .map((column) => column.name),
      ).toEqual([
        'id',
        'conversation_id',
        'role',
        'content',
        'tool_calls_json',
        'model',
        'input_tokens',
        'output_tokens',
        'created_at',
      ]);
    } finally {
      old.close();
    }
  });

  it('guarda mensajes, llamadas y resultados de herramientas, modelo y tokens sin alterar el JSON', () => {
    const conversation = repo.create('Prueba con ñ');
    const calls = '[ { "id": "call-1", "name": "listResults", "input": {} } ]';
    repo.append(conversation.id, [
      { role: 'user', content: '¿Qué ocurrió?' },
      {
        role: 'assistant',
        content: '',
        toolCallsJson: calls,
        model: 'test-model',
        inputTokens: 17,
        outputTokens: 9,
      },
      { role: 'tool', content: '{"tool_use_id":"call-1","results":[]}' },
      {
        role: 'assistant',
        content: 'No hay resultados.',
        model: 'test-model',
        inputTokens: 21,
        outputTokens: 4,
      },
    ]);
    const messages = repo.recentMessages(conversation.id);
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(messages[1]).toMatchObject({
      toolCallsJson: calls,
      model: 'test-model',
      inputTokens: 17,
      outputTokens: 9,
    });
    expect(messages[0]).toMatchObject({
      model: null,
      inputTokens: null,
      outputTokens: null,
      toolCallsJson: null,
    });
    expect(messages[2]!.content).toBe('{"tool_use_id":"call-1","results":[]}');
    const assistant = makeAssistant();
    expect(assistant.openConversation(conversation.id).messages).toEqual(
      messages,
    );
    expect(assistant.turns()).toEqual([
      { question: '¿Qué ocurrió?', answer: 'No hay resultados.' },
    ]);
  });

  it('respeta claves foráneas, roles y borrado en cascada', () => {
    const id = repo.create().id;
    const insert = db.prepare(
      'INSERT INTO ai_messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)',
    );
    expect(() => insert.run('m', 'missing', 'user', 'hola', 'now')).toThrow();
    expect(() => insert.run('m', id, 'system', 'hola', 'now')).toThrow();
    repo.append(id, [{ role: 'user', content: 'hola' }]);
    db.prepare('DELETE FROM ai_conversations WHERE id=?').run(id);
    expect(db.prepare('SELECT * FROM ai_messages').all()).toEqual([]);
    expect(() => repo.append(id, [{ role: 'user', content: 'hola' }])).toThrow(
      'no existe',
    );
  });

  it('revierte el lote completo y updated_at si un mensaje es inválido', () => {
    const initial = repo.create();
    for (const invalid of [
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { toolCallsJson: '{invalid' },
    ]) {
      expect(() =>
        repo.append(initial.id, [
          { role: 'user', content: 'No debe quedar guardado' },
          { role: 'assistant', content: 'respuesta', ...invalid },
        ]),
      ).toThrow();
      expect(repo.recentMessages(initial.id)).toEqual([]);
      expect(repo.get(initial.id)).toEqual(initial);
    }
  });

  it('ordena por actualización, desempata de forma estable y pagina', () => {
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(
      '2026-10-02T12:00:00.000Z',
    );
    const first = repo.create('primera');
    const second = repo.create('segunda');
    expect(repo.list({ limit: 1 })).toEqual([second]);
    expect(repo.list({ limit: 1, offset: 1 })).toEqual([first]);
    vi.mocked(Date.prototype.toISOString).mockReturnValue(
      '2026-10-02T12:01:00.000Z',
    );
    repo.append(first.id, [{ role: 'user', content: 'nueva pregunta' }]);
    expect(repo.list().map((c) => c.id)).toEqual([first.id, second.id]);
    expect(() => repo.list({ limit: 0 })).toThrow();
    expect(() => repo.recentMessages(first.id, 11)).toThrow();
  });
});

describe('AssistantOrchestrator: guardar y recuperar conversaciones', () => {
  it('conserva 12 turnos al reiniciar y carga solo los últimos 10 en la Queue y el proveedor', async () => {
    // Fechas idénticas: debe prevalecer el orden de inserción, nunca el UUID aleatorio.
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(
      '2026-10-02T12:00:00.000Z',
    );
    const fake = new FakeAIProvider();
    let assistant = makeAssistant(fake);
    for (let i = 1; i <= 12; i++) {
      fake.enqueueReply(`R${i}`, {
        model: 'claude-test',
        usage: { inputTokens: i * 10, outputTokens: i },
      });
      await assistant.ask({ message: `P${i}` });
    }
    const id = assistant.listConversations()[0]!.id;
    const path = db.path;
    db.close();
    db = new Database(path);
    expect(new MigrationRunner(db).run()).toEqual([]);
    assistant = makeAssistant(fake);
    expect(assistant.historyTurns).toBe(0);
    const opened = assistant.openConversation(id);
    expect(opened.historyTurns).toBe(10);
    expect(opened.messages).toHaveLength(20);
    expect(opened.messages.at(-1)).toMatchObject({
      content: 'R12',
      model: 'claude-test',
      inputTokens: 120,
      outputTokens: 12,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM ai_messages').get(),
    ).toMatchObject({ n: 24 });
    expect(assistant.turns().map((t) => t.question)).toEqual(
      Array.from({ length: 10 }, (_, i) => `P${i + 3}`),
    );
    fake.enqueueReply('R13');
    await assistant.ask({ message: 'P13' });
    expect(fake.assistantRequests.at(-1)!.messages).toHaveLength(21);
    expect(fake.assistantRequests.at(-1)!.messages[0]).toEqual({
      role: 'user',
      content: 'P3',
    });
    expect(assistant.listConversations()).toHaveLength(1);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM ai_messages').get(),
    ).toMatchObject({ n: 26 });
  });

  it('nueva conversación conserva el historial y un ID inexistente no modifica la activa', async () => {
    const fake = new FakeAIProvider().enqueueReply('A1').enqueueReply('B1');
    const assistant = makeAssistant(fake);
    await assistant.ask({ message: 'conversación A' });
    const first = assistant.listConversations()[0]!.id;
    assistant.reset();
    await assistant.ask({ message: 'conversación B' });
    expect(assistant.listConversations()).toHaveLength(2);
    expect(() => assistant.openConversation('inexistente')).toThrow(
      'no existe',
    );
    expect(assistant.turns()).toEqual([
      { question: 'conversación B', answer: 'B1' },
    ]);
    assistant.openConversation(first);
    expect(assistant.turns()).toEqual([
      { question: 'conversación A', answer: 'A1' },
    ]);
  });

  it('guarda la pregunta sin contexto ni errores internos cuando no hay respuesta de IA', async () => {
    const fake = new FakeAIProvider().enqueueReplyError('OFFLINE', {
      message: 'error-interno-privado',
    });
    const assistant = makeAssistant(fake);
    await assistant.ask({ message: 'hola' });
    const id = assistant.listConversations()[0]!.id;
    expect(repo.recentMessages(id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'hola'],
    ]);
    expect(assistant.openConversation(id).historyTurns).toBe(0);
    expect(JSON.stringify(repo.recentMessages(id))).not.toContain(
      'error-interno-privado',
    );
    fake.enqueueReply('sí funciona');
    await assistant.ask({ message: '¿ahora?' });
    assistant.openConversation(id);
    expect(assistant.turns()).toEqual([
      { question: '¿ahora?', answer: 'sí funciona' },
    ]);
  });

  it('una pregunta inválida no crea conversaciones vacías', async () => {
    const assistant = makeAssistant();
    await expect(assistant.ask({ message: ' ' })).rejects.toThrow();
    await expect(
      assistant.ask({ message: 'hola', focus: { resultId: 'inexistente' } }),
    ).rejects.toThrow();
    expect(assistant.listConversations()).toEqual([]);
  });

  it('los intentos sin respuesta no expulsan pares completos al reabrir', async () => {
    const fake = new FakeAIProvider();
    const assistant = makeAssistant(fake);
    for (let i = 0; i < 10; i++) {
      fake.enqueueReply(`R${i}`);
      await assistant.ask({ message: `P${i}` });
    }
    const before = assistant.turns();
    for (let i = 0; i < 11; i++) {
      fake.enqueueReplyError('OFFLINE');
      await assistant.ask({ message: `sin red ${i}` });
    }
    const id = assistant.listConversations()[0]!.id;
    expect(assistant.openConversation(id).historyTurns).toBe(10);
    expect(assistant.turns()).toEqual(before);
  });

  it('al abrir otra conversación cancela la respuesta tardía y las preguntas aún en cola', async () => {
    const target = repo.create('destino').id;
    repo.append(target, [
      { role: 'user', content: 'guardada' },
      { role: 'assistant', content: 'respuesta guardada' },
    ]);
    const fake = new FakeAIProvider();
    let finish!: (value: AIResult<string>) => void;
    let received: AssistantTurnRequest | undefined;
    vi.spyOn(fake, 'runAssistantTurn').mockImplementation((request) => {
      received = request;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const assistant = makeAssistant(fake);
    const pending = assistant.ask({ message: 'en vuelo' });
    const queued = assistant.ask({ message: 'todavía en cola' });
    await expect.poll(() => received).toBeDefined();
    assistant.openConversation(target);
    expect(received!.signal!.aborted).toBe(true);
    finish({
      ok: true,
      value: 'respuesta tardía',
      model: 'fake',
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 0,
    });
    expect((await pending).status).toBe('CANCELLED');
    expect((await queued).status).toBe('CANCELLED');
    expect(fake.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(assistant.turns()).toEqual([
      { question: 'guardada', answer: 'respuesta guardada' },
    ]);
    expect(repo.recentMessages(target)).toHaveLength(2);
    expect(
      db
        .prepare(
          "SELECT content FROM ai_messages WHERE content IN ('respuesta tardía','todavía en cola')",
        )
        .all(),
    ).toEqual([]);
  });
});

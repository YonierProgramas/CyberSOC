import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Database } from '../src/core/persistence/Database';
import { MigrationRunner } from '../src/core/persistence/MigrationRunner';
import { initialMigration } from '../src/core/persistence/migrations/001_init';
import { scansMigration } from '../src/core/persistence/migrations/002_scans';
import { evidenceAiMigration } from '../src/core/persistence/migrations/003_evidence_ai';
import { zonesMigration } from '../src/core/persistence/migrations/004_zones';
import { quarantineMigration } from '../src/core/persistence/migrations/005_quarantine';
import { conversationsMigration } from '../src/core/persistence/migrations/006_conversations';
import { assistantCardsMigration } from '../src/core/persistence/migrations/007_assistant_cards';
import { ConversationRepository } from '../src/core/persistence/ConversationRepository';
import { ConversationArchiveReader } from '../src/core/persistence/ConversationArchiveReader';
import { AssistantOrchestrator } from '../src/core/ai/AssistantOrchestrator';
import { FakeAIProvider } from '../src/core/ai/providers/FakeAIProvider';
import { appConfigSchema } from '../src/core/config/AppConfig';
import { ReportBuilder } from '../src/core/reports/ReportBuilder';
import { ScanJobRepository } from '../src/core/persistence/ScanJobRepository';
import { assistantCardV1Schema } from '../src/shared/assistant-card-schemas';
import { messagesPageSchema } from '../src/shared/history-schemas';
import {
  ASSISTANT_CARD_MAX_BYTES,
  ASSISTANT_CARD_SCHEMA_V1,
  type ConversationHistoryItemDTO,
} from '../src/shared/ipc';
import {
  emptyCard,
  cardAtBytes,
  seedHistory,
  seedMessages,
} from './fixtures/history';
import { copilotDeps, final } from './fixtures/copilot';

const six = [
  initialMigration,
  scansMigration,
  evidenceAiMigration,
  zonesMigration,
  quarantineMigration,
  conversationsMigration,
];
let root: string,
  db: Database,
  repo: ConversationRepository,
  archive: ConversationArchiveReader;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cybersoc-archive-'));
  db = new Database(join(root, 'fixture.sqlite'));
  new MigrationRunner(db).run();
  repo = new ConversationRepository(db);
  archive = new ConversationArchiveReader(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it('I-07/I-09/I-14: recorre250 mensajes sin duplicados, cursor ligado al chat, tool input ausente y pregunta sin respuesta', () => {
  const id = seedMessages(db);
  const other = repo.create('otro').id;
  repo.append(other, [{ role: 'user', content: 'otra' }]);
  const foreignCursor = repo.recentMessages(other)[0]!.id;
  expect(() =>
    archive.listMessages({ conversationId: id, before: foreignCursor }),
  ).toThrow('Cursor');
  const backwards: ConversationHistoryItemDTO[] = [];
  let before: string | undefined;
  do {
    const page = archive.listMessages({
      conversationId: id,
      limit: 19,
      ...(before ? { before } : {}),
    });
    expect(page.total).toBe(250);
    messagesPageSchema.parse(page);
    backwards.unshift(...page.items);
    before = page.olderCursor ?? undefined;
  } while (before);
  const ids = db
    .prepare(
      'SELECT id FROM ai_messages WHERE conversation_id=? ORDER BY rowid',
    )
    .all(id)
    .map((row) => row.id);
  expect(backwards.map((item) => item.id)).toEqual(ids);
  expect(new Set(backwards.map((item) => item.id)).size).toBe(250);
  expect(JSON.stringify(backwards)).not.toContain('PRIVADO-SINTETICO');
  expect(JSON.stringify(backwards)).not.toContain('secreto-de-fixture');
  expect(JSON.stringify(backwards)).not.toContain('cadena privada');
  expect(backwards.at(-1)).toMatchObject({ kind: 'USER', answered: false });
  expect(backwards[0]).toMatchObject({ kind: 'USER', answered: true });
  for (const input of [
    { limit: 0 },
    { limit: 101 },
    { extra: true },
    { conversationId: 'no-uuid' },
    { before: 'no-uuid' },
  ])
    expect(() =>
      archive.listMessages({ conversationId: id, ...input } as never),
    ).toThrow();
});

it('I-08/I-14: leer y paginar no cambia activa/Queue ni llama reset/open/ask/proveedor', async () => {
  const fake = new FakeAIProvider()
    .enqueueFinal(final('respuesta A'))
    .enqueueReplyError('OFFLINE');
  const assistant = new AssistantOrchestrator({
    db,
    provider: () => fake,
    readConfig: () => appConfigSchema.parse({}),
    ...copilotDeps(db),
  });
  await assistant.ask({ message: 'A' });
  const id = assistant.listConversations()[0]!.id;
  const before = assistant.turns();
  const reset = vi.spyOn(assistant, 'reset'),
    open = vi.spyOn(assistant, 'openConversation'),
    ask = vi.spyOn(assistant, 'ask');
  const requests = fake.assistantRequests.length;
  const old = seedMessages(db);
  archive.listMessages({ conversationId: old });
  repo.listPage({ offset: 0, limit: 2 });
  expect(assistant.turns()).toEqual(before);
  expect(assistant.historyTurns).toBe(1);
  expect(reset).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(ask).not.toHaveBeenCalled();
  expect(fake.assistantRequests).toHaveLength(requests);
  await assistant.ask({ message: 'fallida en la misma activa' });
  const page = archive.listMessages({ conversationId: id });
  expect(page.items.at(-1)).toMatchObject({ kind: 'USER', answered: false });
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM ai_message_cards WHERE message_id IN (SELECT id FROM ai_messages WHERE conversation_id=?)',
      )
      .get(id)!.n,
  ).toBe(1);
});

it('I-10: backup coherente006→007 conserva tablas/filas y revierte una007 fallida; downgrade rechazado', async () => {
  const old = new Database(join(root, 'old006.sqlite'));
  new MigrationRunner(old, six).run();
  const legacy = new ConversationRepository(old);
  const chat = legacy.create('legado');
  legacy.append(chat.id, [
    { role: 'user', content: 'pregunta' },
    {
      role: 'assistant',
      content: 'respuesta',
      model: 'fake-old',
      inputTokens: 7,
      outputTokens: 9,
    },
  ]);
  seedHistory(old, 10, 20);
  old
    .prepare('INSERT INTO settings VALUES (?,?,?)')
    .run('persistir', '{}', '2026-01-01');
  const tables = old
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
  const beforeTables = Object.fromEntries(
    tables.map((table) => [
      table,
      old.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
    ]),
  );
  const dump = old.prepare('SELECT * FROM ai_messages ORDER BY rowid').all();
  const source = new DatabaseSync(old.path, { readOnly: true });
  try {
    await backup(source, join(root, 'copy.sqlite'));
  } finally {
    source.close();
    old.close();
  }
  const copy = new Database(join(root, 'copy.sqlite'));
  try {
    expect(new MigrationRunner(copy).run()).toEqual([7]);
    expect(new MigrationRunner(copy).run()).toEqual([]);
    expect(
      copy.prepare('SELECT * FROM ai_messages ORDER BY rowid').all(),
    ).toEqual(dump);
    expect(copy.prepare('SELECT * FROM settings').all()).toEqual([
      { key: 'persistir', value_json: '{}', updated_at: '2026-01-01' },
    ]);
    expect(copy.prepare('SELECT json_valid(?) ok').get('{}')!.ok).toBe(1);
    expect(copy.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe(
      'ok',
    );
    expect(copy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const table of tables) {
      const after = copy
        .prepare(
          `SELECT * FROM "${table}" ${table === 'schema_migrations' ? 'WHERE version<=6' : ''} ORDER BY rowid`,
        )
        .all();
      expect(after).toEqual(beforeTables[table]);
    }
    expect(
      copy
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='idx_ai_messages_conversation'",
        )
        .get(),
    ).toBeDefined();
    expect(() => new MigrationRunner(copy, six).run()).toThrow('historial');
    const message = new ConversationArchiveReader(copy)
      .listMessages({ conversationId: chat.id })
      .items.at(-1);
    expect(message).toMatchObject({
      kind: 'ASSISTANT',
      cardState: 'NOT_RECORDED',
      card: null,
      actionStates: [],
    });
  } finally {
    copy.close();
  }
  const broken = new Database(join(root, 'broken006.sqlite'));
  try {
    new MigrationRunner(broken, six).run();
    const failing = {
      ...assistantCardsMigration,
      up(database: Database) {
        assistantCardsMigration.up(database);
        throw new Error('fallo 007');
      },
    };
    expect(() => new MigrationRunner(broken, [...six, failing]).run()).toThrow(
      'fallo 007',
    );
    expect(
      broken.prepare('SELECT MAX(version) n FROM schema_migrations').get()!.n,
    ).toBe(6);
    expect(
      broken
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('ai_message_cards','idx_ai_messages_conversation')",
        )
        .all(),
    ).toEqual([]);
  } finally {
    broken.close();
  }
});

it('I-11/I-18: ida y vuelta fiel; seis acciones recalculadas por recurso/veredicto y TTL de sesión', () => {
  seedHistory(db, 3, 6);
  let time = 1000;
  const reports = new ReportBuilder(db, { now: () => time, ttlMs: 10 });
  const draft = reports.build();
  const reader = new ConversationArchiveReader(db, (id) => {
    try {
      reports.get(id);
      return true;
    } catch {
      return false;
    }
  });
  const id = repo.create().id;
  const card = emptyCard();
  card.focus = { kind: 'RESULT', id: 'synthetic-3', label: 'sintético' };
  card.references = [{ type: 'result', id: 'synthetic-3' }];
  card.suggestedActions = [
    { action: 'OPEN_RESULT', targetId: 'synthetic-3' },
    { action: 'ANALYZE_WITH_AI', targetId: 'synthetic-3' },
    { action: 'QUARANTINE', targetId: 'synthetic-3' },
    { action: 'OPEN_QUARANTINE', targetId: null },
    { action: 'EXPORT_REPORT', targetId: draft.reportDraftId },
    { action: 'RUN_SCAN_PLAN', targetId: null },
  ];
  card.report = {
    reportDraftId: draft.reportDraftId,
    total: draft.total,
    verdicts: [],
    executiveSummary: 'texto sintético',
    conclusions: [],
    citedResultIds: [],
    label: 'Generado por IA',
  };
  card.scanPlan = cardAtBytes(4096).scanPlan;
  repo.appendAnsweredWithCard(id, { content: 'texto', model: 'fake' }, card);
  let item = reader.listMessages({ conversationId: id }).items[0]!;
  expect(item).toMatchObject({
    kind: 'ASSISTANT',
    cardState: 'RECORDED',
    card,
  });
  if (item.kind !== 'ASSISTANT') throw new Error('tipo');
  expect(item.actionStates.map((state) => state.availability)).toEqual([
    'AVAILABLE',
    'AVAILABLE',
    'AVAILABLE',
    'AVAILABLE',
    'AVAILABLE',
    'HISTORY_READ_ONLY',
  ]);
  time += 11;
  db.prepare(
    "UPDATE scan_results SET verdict='CLEAN' WHERE id='synthetic-3'",
  ).run();
  item = reader.listMessages({ conversationId: id }).items[0]!;
  if (item.kind !== 'ASSISTANT') throw new Error('tipo');
  expect(item.actionStates[2]!.availability).toBe('NOT_APPLICABLE');
  expect(item.actionStates[4]!.availability).toBe('EXPIRED');
  db.prepare("DELETE FROM scan_results WHERE id='synthetic-3'").run();
  item = reader.listMessages({ conversationId: id }).items[0]!;
  if (item.kind !== 'ASSISTANT') throw new Error('tipo');
  expect(
    item.actionStates.slice(0, 3).map((state) => state.availability),
  ).toEqual(['MISSING', 'MISSING', 'MISSING']);
  expect(item.card).toEqual(card);
  expect(
    String(
      db.prepare('SELECT card_json FROM ai_message_cards').get()!.card_json,
    ),
  ).not.toContain('availability');
});

it('I-15: CHECK SQLite cuenta UTF-8 exacto, acepta2097152 y rechaza2097153; estados incoherentes rechazados', () => {
  const id = repo.create().id;
  repo.append(id, [{ role: 'assistant', content: 'legado' }]);
  const message = repo.recentMessages(id); // No user: consultar ID directamente.
  expect(message).toEqual([]);
  const messageId = String(
    db.prepare('SELECT id FROM ai_messages WHERE conversation_id=?').get(id)!
      .id,
  );
  const insert = db.prepare(
    'INSERT INTO ai_message_cards VALUES(?,?,?,?,?,?,?)',
  );
  const json = JSON.stringify('x'.repeat(ASSISTANT_CARD_MAX_BYTES - 2));
  insert.run(
    messageId,
    ASSISTANT_CARD_SCHEMA_V1,
    'STORED',
    json,
    null,
    Buffer.byteLength(json),
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare('DELETE FROM ai_message_cards').run();
  expect(() =>
    insert.run(
      messageId,
      ASSISTANT_CARD_SCHEMA_V1,
      'STORED',
      JSON.stringify('x'.repeat(ASSISTANT_CARD_MAX_BYTES - 1)),
      null,
      ASSISTANT_CARD_MAX_BYTES + 1,
      '2026-01-01',
    ),
  ).toThrow('CHECK');
  const utf8 = JSON.stringify('€'.repeat(699_051));
  expect(utf8.length).toBeLessThan(ASSISTANT_CARD_MAX_BYTES);
  expect(Buffer.byteLength(utf8)).toBeGreaterThan(ASSISTANT_CARD_MAX_BYTES);
  expect(() =>
    insert.run(
      messageId,
      ASSISTANT_CARD_SCHEMA_V1,
      'STORED',
      utf8,
      null,
      Buffer.byteLength(utf8),
      '2026-01-01',
    ),
  ).toThrow('CHECK');
  for (const [state, value, reason] of [
    ['STORED', '{}', 'INVALID'],
    ['OMITTED', '{}', 'INVALID'],
    ['OMITTED', null, null],
    ['STORED', 'bad', null],
  ] as const)
    expect(() =>
      insert.run(
        messageId,
        ASSISTANT_CARD_SCHEMA_V1,
        state,
        value,
        reason,
        0,
        '2026-01-01',
      ),
    ).toThrow();
});

it('I-15/I-16: tarjetas máximas válidas; exceso/invalidez OMITTED sin perder texto y lectura inválida segura', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const id = repo.create().id;
  for (const char of ['x', '€', '\u0001']) {
    const card = cardAtBytes(1024 * 1024);
    for (const target of card.scanPlan!.targets)
      target.paths = target.paths.map(() => char.repeat(1024));
    card.focus.label = char.repeat(32767);
    card.focus.kind = 'RESULT';
    card.focus.id = char.repeat(128);
    card.scanPlan!.rationale = char.repeat(1000);
    card.scanPlan!.profile.maxFileSizeMB = Math.floor(
      Number.MAX_SAFE_INTEGER / 1_048_576,
    );
    card.scanPlan!.profile.layers = [
      'HASH',
      'SIGNATURES',
      'FILETYPE',
      'RULES',
      'HEURISTICS',
      'PE',
      'SCRIPTS',
    ];
    for (const target of card.scanPlan!.targets) {
      target.driveId = char.repeat(8);
      target.zoneId = 'DOCUMENTOS';
    }
    card.scanPlan!.layerRationale = Array.from({ length: 7 }, () => ({
      layer: 'SIGNATURES' as const,
      why: char.repeat(400),
    }));
    card.report = {
      reportDraftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      total: Number.MAX_SAFE_INTEGER,
      verdicts: Array.from({ length: 10 }, () => ({
        verdict: char.repeat(32),
        count: Number.MAX_SAFE_INTEGER,
      })),
      executiveSummary: char.repeat(8000),
      conclusions: Array.from({ length: 20 }, () => char.repeat(2000)),
      citedResultIds: Array.from({ length: 100 }, () => char.repeat(128)),
      label: 'Generado por IA',
    };
    card.references = Array.from({ length: 20 }, () => ({
      type: 'result' as const,
      id: char.repeat(128),
    }));
    card.suggestedActions = Array.from({ length: 6 }, () => ({
      action: 'ANALYZE_WITH_AI' as const,
      targetId: char.repeat(128),
    }));
    assistantCardV1Schema.parse(card);
    const byteSize = Buffer.byteLength(JSON.stringify(card));
    expect(byteSize).toBe(
      char === 'x' ? 309393 : char === '€' ? 921439 : 1839508,
    );
    // El cálculo conservador del anexo usa seis bytes más: aquí maxFileSizeMB
    // respeta el máximo REAL del esquema (MAX_SAFE_INTEGER / 1 MiB), no MAX_SAFE_INTEGER.
    expect(byteSize).toBeLessThan(ASSISTANT_CARD_MAX_BYTES);
    console.log(
      JSON.stringify({
        test: 'I-15',
        case: char === 'x' ? 'ASCII' : char === '€' ? '3-byte' : 'control',
        byteSize,
      }),
    );
    const message = repo.appendAnsweredWithCard(
      id,
      { content: 'máxima' },
      card,
    );
    expect(
      db
        .prepare(
          'SELECT state,byte_size FROM ai_message_cards WHERE message_id=?',
        )
        .get(message),
    ).toMatchObject({
      state: 'STORED',
      byte_size: Buffer.byteLength(JSON.stringify(card)),
    });
  }
  const large = repo.appendAnsweredWithCard(
    id,
    { content: 'texto completo' },
    emptyCard(),
    1,
  );
  const invalid = {
    ...emptyCard(),
    focus: { kind: 'NONE', id: null, label: 'x'.repeat(32768) },
  };
  const bad = repo.appendAnsweredWithCard(
    id,
    { content: 'otro texto completo' },
    invalid,
  );
  expect(
    db
      .prepare('SELECT omitted_reason FROM ai_message_cards WHERE message_id=?')
      .get(large)!.omitted_reason,
  ).toBe('TOO_LARGE');
  expect(
    db
      .prepare('SELECT omitted_reason FROM ai_message_cards WHERE message_id=?')
      .get(bad)!.omitted_reason,
  ).toBe('INVALID');
  expect(
    archive.listMessages({ conversationId: id }).items.slice(-2),
  ).toMatchObject([
    { text: 'texto completo', cardState: 'OMITTED', card: null },
    { text: 'otro texto completo', cardState: 'OMITTED', card: null },
  ]);
  const corrupt = repo.appendAnsweredWithCard(
    id,
    { content: 'conservado' },
    emptyCard(),
  );
  db.prepare(
    "UPDATE ai_message_cards SET card_json='{}' WHERE message_id=?",
  ).run(corrupt);
  expect(
    archive.listMessages({ conversationId: id }).items.at(-1),
  ).toMatchObject({ text: 'conservado', cardState: 'OMITTED', card: null });
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('texto completo');
});

it('I-16: foco fuera de cota omite solo tarjeta; respuesta viva y Queue conservan su comportamiento', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const long = 'x'.repeat(32768);
  const jobs = new ScanJobRepository(db);
  jobs.create({ id: 'foco-largo', targetKind: 'FOLDER', targetPath: long });
  const fake = new FakeAIProvider().enqueueFinal(final('respuesta completa'));
  const assistant = new AssistantOrchestrator({
    db,
    provider: () => fake,
    readConfig: () => appConfigSchema.parse({}),
    ...copilotDeps(db),
  });
  const reply = await assistant.ask({
    message: 'explica',
    focus: { jobId: 'foco-largo' },
  });
  expect(reply).toMatchObject({
    status: 'ANSWERED',
    text: 'respuesta completa',
    focus: { label: long },
    historyTurns: 1,
  });
  const id = assistant.listConversations()[0]!.id;
  expect(
    archive.listMessages({ conversationId: id }).items.at(-1),
  ).toMatchObject({
    kind: 'ASSISTANT',
    text: 'respuesta completa',
    cardState: 'OMITTED',
    card: null,
  });
});

it('I-15: reproduce plan103266B y reporte Unicode96374B de7.E bajo la007 real', () => {
  const id = repo.create().id;
  const plan = emptyCard();
  const path = 'C:/Ejemplo/' + 'a'.repeat(1013);
  plan.scanPlan = {
    schema: 'cybersoc.scan-plan/v1',
    targets: (
      [
        'DOCUMENTOS',
        'DESCARGAS',
        'ESCRITORIO',
        'PROGRAMAS',
        'DATOS_APPS',
      ] as const
    ).map((zoneId) => ({ zoneId, driveId: null, paths: Array(20).fill(path) })),
    profile: {
      layers: ['HASH', 'SIGNATURES'],
      includeHidden: false,
      maxFileSizeMB: 100,
    },
    rationale: 'Ejemplo',
    layerRationale: [],
  };
  const report = emptyCard();
  report.report = {
    reportDraftId: '00000000-0000-4000-8000-000000000001',
    total: 0,
    verdicts: [],
    executiveSummary: 'á'.repeat(8000),
    conclusions: Array(20).fill('á'.repeat(2000)),
    citedResultIds: [],
    label: 'Generado por IA',
  };
  // El orden de propiedades de 7.E ponía scanPlan antes de report; no afecta bytes.
  expect(Buffer.byteLength(JSON.stringify(plan))).toBe(103266);
  expect(Buffer.byteLength(JSON.stringify(report))).toBe(96374);
  for (const card of [plan, report]) {
    assistantCardV1Schema.parse(card);
    const message = repo.appendAnsweredWithCard(
      id,
      { content: 'prueba de regresión de tamaño' },
      card,
    );
    expect(
      db
        .prepare(
          'SELECT state,byte_size FROM ai_message_cards WHERE message_id=?',
        )
        .get(message),
    ).toMatchObject({
      state: 'STORED',
      byte_size: Buffer.byteLength(JSON.stringify(card)),
    });
  }
});

it('I-17/I-18: fallo SQL revierte respuesta/tarjeta sin avanzar Queue; viva y archivada fieles', async () => {
  const fake = new FakeAIProvider()
    .enqueueFinal(final('respuesta uno'))
    .enqueueFinal(final('respuesta no confirmada'));
  const assistant = new AssistantOrchestrator({
    db,
    provider: () => fake,
    readConfig: () => appConfigSchema.parse({}),
    ...copilotDeps(db),
  });
  const reply = await assistant.ask({ message: 'uno' });
  const id = assistant.listConversations()[0]!.id;
  const archived = archive.listMessages({ conversationId: id }).items.at(-1)!;
  expect(archived).toMatchObject({
    kind: 'ASSISTANT',
    text: reply.text,
    card: {
      schema: ASSISTANT_CARD_SCHEMA_V1,
      focus: reply.focus,
      references: reply.references,
      suggestedActions: reply.suggestedActions,
      report: reply.report,
      scanPlan: reply.scanPlan,
    },
  });
  db.exec(
    "CREATE TRIGGER fail_card BEFORE INSERT ON ai_message_cards BEGIN SELECT RAISE(ABORT,'fallo sintético'); END",
  );
  const before = assistant.turns();
  await expect(assistant.ask({ message: 'dos' })).rejects.toThrow(
    'fallo sintético',
  );
  expect(assistant.turns()).toEqual(before);
  expect(assistant.historyTurns).toBe(1);
  expect(
    db
      .prepare("SELECT COUNT(*) n FROM ai_messages WHERE role='assistant'")
      .get()!.n,
  ).toBe(1);
  expect(db.prepare('SELECT COUNT(*) n FROM ai_message_cards').get()!.n).toBe(
    1,
  );
  expect(
    archive.listMessages({ conversationId: id }).items.at(-1),
  ).toMatchObject({ kind: 'USER', text: 'dos', answered: false });
});

it('I-20:30 tarjetas válidas de1MiB → páginas≤8MiB, sin omisiones y con cursor estable ante append', () => {
  const id = repo.create().id,
    card = cardAtBytes(1024 * 1024);
  assistantCardV1Schema.parse(card);
  db.transaction(() => {
    for (let index = 0; index < 30; index++)
      repo.appendAnsweredWithCard(id, { content: `respuesta ${index}` }, card);
  });
  const ids = db
    .prepare(
      'SELECT id FROM ai_messages WHERE conversation_id=? ORDER BY rowid',
    )
    .all(id)
    .map((row) => row.id);
  let page = archive.listMessages({ conversationId: id, limit: 100 });
  expect(page.items).toHaveLength(8);
  repo.append(id, [
    { role: 'user', content: 'nueva llegada no desplaza cursor' },
  ]);
  const found = page.items.map((item) => item.id);
  while (page.olderCursor) {
    page = archive.listMessages({
      conversationId: id,
      before: page.olderCursor,
      limit: 100,
    });
    expect(page.items.length).toBeGreaterThan(0);
    const bytes = page.items.reduce(
      (sum, item) =>
        sum +
        (item.kind === 'ASSISTANT' && item.card
          ? Buffer.byteLength(JSON.stringify(item.card))
          : 0),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    found.unshift(...page.items.map((item) => item.id));
  }
  expect(found).toEqual(ids);
  expect(new Set(found).size).toBe(30);
});

it('lista conversaciones con total/conteos correctos, orden estable y páginas completas', () => {
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(
    '2026-11-04T12:00:00.000Z',
  );
  const a = seedMessages(db, 3),
    b = repo.create('segunda').id;
  expect(repo.listPage({ offset: 0, limit: 1 })).toMatchObject({
    total: 2,
    items: [{ id: b, messageCount: 0, lastMessageAt: null }],
  });
  expect(repo.listPage({ offset: 1, limit: 1 })).toMatchObject({
    total: 2,
    items: [
      { id: a, messageCount: 2, lastMessageAt: '2026-11-04T12:00:00.000Z' },
    ],
  });
});

import { z } from 'zod';
import type { Database } from '../persistence/Database';

const positiveInt = z.number().int().positive();
const modelName = z.string().min(1);
const analysisModel = 'claude-haiku-4-5-20251001';

const engineSchema = z.strictObject({
  requestTimeoutMs: positiveInt.default(30_000),
});
const scanSchema = z.strictObject({
  maxFileSizeMB: positiveInt.default(256),
  queueCapacity: positiveInt.default(1_000),
});
const aiSchema = z.strictObject({
  analysisModel: modelName.default(analysisModel),
  assistantModel: modelName.default(analysisModel),
  autoAnalyzeLimitPerScan: z.number().int().nonnegative().default(50),
  sendFileNames: z.boolean().default(true),
});

export const appConfigSchema = z.strictObject({
  engine: engineSchema.default({ requestTimeoutMs: 30_000 }),
  scan: scanSchema.default({ maxFileSizeMB: 256, queueCapacity: 1_000 }),
  ai: aiSchema.default({
    analysisModel,
    assistantModel: analysisModel,
    autoAnalyzeLimitPerScan: 50,
    sendFileNames: true,
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

const sections = ['engine', 'scan', 'ai'] as const;
type Section = (typeof sections)[number];

const fields: Record<Section, readonly string[]> = {
  engine: ['requestTimeoutMs'],
  scan: ['maxFileSizeMB', 'queueCapacity'],
  ai: [
    'analysisModel',
    'assistantModel',
    'autoAnalyzeLimitPerScan',
    'sendFileNames',
  ],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSection(value: string): value is Section {
  return sections.some((section) => section === value);
}

function settingEntries(config: AppConfig): Array<[string, unknown]> {
  return [
    ['engine.requestTimeoutMs', config.engine.requestTimeoutMs],
    ['scan.maxFileSizeMB', config.scan.maxFileSizeMB],
    ['scan.queueCapacity', config.scan.queueCapacity],
    ['ai.analysisModel', config.ai.analysisModel],
    ['ai.assistantModel', config.ai.assistantModel],
    ['ai.autoAnalyzeLimitPerScan', config.ai.autoAnalyzeLimitPerScan],
    ['ai.sendFileNames', config.ai.sendFileNames],
  ];
}

function readStored(database: Database): unknown {
  const draft: Record<Section, Record<string, unknown>> = {
    engine: {},
    scan: {},
    ai: {},
  };
  for (const row of database
    .prepare('SELECT key, value_json FROM settings')
    .all()) {
    if (typeof row.key !== 'string' || typeof row.value_json !== 'string') {
      throw new Error('La tabla settings tiene una fila ilegible.');
    }
    const dot = row.key.indexOf('.');
    if (dot === -1) continue;
    const section = row.key.slice(0, dot);
    const field = row.key.slice(dot + 1);
    if (!isSection(section) || !fields[section].includes(field)) continue;
    try {
      draft[section][field] = JSON.parse(row.value_json);
    } catch {
      throw new Error(`El ajuste "${row.key}" no contiene JSON válido.`);
    }
  }
  return draft;
}

function mergeInput(current: AppConfig, input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const merged: Record<string, unknown> = { ...current, ...input };
  for (const section of sections) {
    if (!Object.hasOwn(input, section)) continue;
    const patch = input[section];
    merged[section] = isPlainObject(patch)
      ? { ...current[section], ...patch }
      : patch;
  }
  return merged;
}

export class AppConfigStore {
  constructor(private readonly database: Database) {}

  load(): AppConfig {
    return appConfigSchema.parse(readStored(this.database));
  }

  save(input: unknown): AppConfig {
    const config = appConfigSchema.parse(mergeInput(this.load(), input));
    const updatedAt = new Date().toISOString();
    const statement = this.database.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    );
    this.database.transaction(() => {
      for (const [key, value] of settingEntries(config)) {
        statement.run(key, JSON.stringify(value), updatedAt);
      }
    });
    return config;
  }
}

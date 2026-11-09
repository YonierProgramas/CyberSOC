import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiAssessmentSchema } from '../../src/core/ai/schemas';
import type { Database } from '../../src/core/persistence/Database';
import type { SecretStore } from '../../src/main/SecretStore';

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, setPath: vi.fn(), getPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {},
}));
vi.mock('electron', () => electron);

let roots: string[];
let databases: Database[];
const temporary = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};
const secrets = (key: string | null) =>
  ({ getApiKey: () => key }) as SecretStore;

beforeEach(() => {
  roots = [];
  databases = [];
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('CYBERSOC_EVIDENCE_MODE', undefined);
  vi.stubEnv('CYBERSOC_EVIDENCE_ROOT', undefined);
  vi.stubEnv('CYBERSOC_EVIDENCE_LIVE', undefined);
  vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', undefined);
});

afterEach(() => {
  for (const db of databases) db.close();
  for (const path of roots) {
    // Only temporary folders created by this test: never a path received from the user.
    expect(realpathSync(dirname(path))).toBe(realpathSync(tmpdir()));
    expect(basename(path)).toMatch(/^cybersoc-(evidence|mode-test)-/);
    rmSync(path, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('evidence mode isolation', () => {
  it.each([undefined, '0', 'true'])(
    'without exact opt-in (%s) keeps the normal DB and provider',
    async (mode) => {
      vi.stubEnv('CYBERSOC_EVIDENCE_MODE', mode);
      vi.stubEnv('CYBERSOC_EVIDENCE_ROOT', 'ruta-invalida-ignorada');
      const normal = temporary('cybersoc-mode-test-');
      const { createDatabase, createAIProvider } =
        await import('../../src/main/composition-root');
      const db = createDatabase(normal);
      databases.push(db);
      expect(existsSync(join(normal, 'cybersoc.db'))).toBe(true);
      expect(electron.app.setPath).not.toHaveBeenCalled();
      expect(createAIProvider(db, secrets(null))).toBeNull();
    },
  );

  it('isolates SQLite, replaces the dialog and delivers a valid Fake without credentials', async () => {
    const normal = temporary('cybersoc-mode-test-');
    const evidence = temporary('cybersoc-evidence-');
    vi.stubEnv('CYBERSOC_EVIDENCE_MODE', '1');
    vi.stubEnv('CYBERSOC_EVIDENCE_ROOT', evidence);
    vi.stubEnv('CYBERSOC_EVIDENCE_DIALOG_PATH', join(evidence, 'fixture.txt'));
    const { createDatabase, createAIProvider } =
      await import('../../src/main/composition-root');
    const db = createDatabase(normal);
    databases.push(db);
    expect(existsSync(join(normal, 'cybersoc.db'))).toBe(false);
    expect(existsSync(join(evidence, 'user-data/cybersoc.db'))).toBe(true);
    expect(electron.app.setPath).toHaveBeenCalledWith(
      'userData',
      join(evidence, 'user-data'),
    );
    expect(await electron.dialog.showOpenDialog()).toEqual({
      canceled: false,
      filePaths: [join(evidence, 'fixture.txt')],
    });
    const provider = createAIProvider(db, secrets(null));
    expect(provider?.id).toBe('fake');
    const result = await provider!.generateStructured({
      prompt: '{}',
      schema: aiAssessmentSchema,
      maxTokens: 1200,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe('fake-evidence-v1');
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.value.citedEvidenceIds).toEqual(['ev1']);
    }
  });

  it('live picks Claude without calling the network during construction', async () => {
    const evidence = temporary('cybersoc-evidence-');
    vi.stubEnv('CYBERSOC_EVIDENCE_MODE', '1');
    vi.stubEnv('CYBERSOC_EVIDENCE_ROOT', evidence);
    vi.stubEnv('CYBERSOC_EVIDENCE_LIVE', '1');
    const { createDatabase, createAIProvider } =
      await import('../../src/main/composition-root');
    const db = createDatabase(evidence);
    databases.push(db);
    expect(createAIProvider(db, secrets('evidence-fixture-1234'))?.id).toBe(
      'claude',
    );
    expect(createAIProvider(db, secrets(null))).toBeNull();
  });

  it('rejects a directory that is not an evidence temporary folder', async () => {
    const normal = temporary('cybersoc-mode-test-');
    vi.stubEnv('CYBERSOC_EVIDENCE_MODE', '1');
    vi.stubEnv('CYBERSOC_EVIDENCE_ROOT', normal);
    const { createDatabase } = await import('../../src/main/composition-root');
    expect(() => createDatabase(normal)).toThrow('temporal aislado');
    expect(existsSync(join(normal, 'cybersoc.db'))).toBe(false);
  });
});

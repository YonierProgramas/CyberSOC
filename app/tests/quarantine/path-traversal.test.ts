import * as fs from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QuarantineItem } from '../../src/core/persistence/QuarantineRepository';
import { exists, validatePath } from '../../src/core/quarantine/paths';
import { QuarantineHarness, sha, type Seeded } from './harness';

vi.setConfig({ testTimeout: 20_000 });

// A single quarantined item serves all attacks: each rejected attempt must leave it
// intact. If one damaged it, the next ones would fail too and it would show in the output.
const h = new QuarantineHarness();
let input: Seeded;
let item: QuarantineItem;
let before: string[];

beforeAll(async () => {
  await h.setup();
  input = await h.seed('original.txt');
  item = await h.manager.quarantine(input.id);
  before = (await fs.readdir(h.root)).sort();
});
afterAll(() => h.close());

/** Absolute attack paths; all point inside the test folder. */
function attacks(): Array<[string, string]> {
  const r = h.root; // p. ej. C:\Users\...\Temp\cybersoc-adversarial-XXXX
  const noDrive = r.slice(2); // \Users\...
  return [
    ['.. con barra invertida', `${r}\\sub\\..\\fuera.txt`],
    ['.. con barra normal', `${r}/sub/../fuera.txt`],
    ['.. con barras mezcladas', `${r}\\sub/..\\fuera.txt`],
    ['.. al final', `${r}\\sub\\..`],
    ['varios ..', `${r}\\a\\b\\..\\..\\..\\fuera.txt`],
    ['.. en MAYÚSCULAS de ruta', `${r.toUpperCase()}\\SUB\\..\\FUERA.TXT`],
    ['segmento "."', `${r}\\.\\fuera.txt`],
    ['segmento "..." (punto final)', `${r}\\...\\fuera.txt`],
    ['UNC \\\\localhost\\C$', `\\\\localhost\\C$${noDrive}\\unc.txt`],
    [
      'UNC con barras normales',
      `//localhost/C$${noDrive.replaceAll('\\', '/')}/unc.txt`,
    ],
    ['UNC mezclado /\\', `/\\localhost\\C$${noDrive}\\unc.txt`],
    ['prefijo \\\\?\\ (ruta larga)', `\\\\?\\${r}\\larga.txt`],
    ['prefijo \\\\.\\ (dispositivo)', `\\\\.\\${r}\\dispositivo.txt`],
    ['prefijo \\??\\ (NT)', `\\??\\${r}\\nt.txt`],
    ['relativa a la raíz de la unidad', `${noDrive}\\raiz.txt`],
    ['relativa a la unidad (C:x)', `${r.slice(0, 2)}fuera.txt`],
    ['flujo alternativo ADS', `${r}\\ads.txt:oculto`],
    ['flujo ::$DATA', `${r}\\ads.txt::$DATA`],
    ['nombre con punto final', `${r}\\punto.txt.`],
    ['nombre con espacio final', `${r}\\espacio.txt `],
    ['dispositivo NUL', `${r}\\NUL`],
    ['dispositivo con extensión con.txt', `${r}\\con.txt`],
    ['dispositivo COM1 en minúsculas', `${r}\\com1.log`],
    ['carácter nulo', `${r}\\nulo\0.txt`],
    ['comodín *', `${r}\\*.txt`],
    ['comillas', `${r}\\"x".txt`],
  ];
}

describe('restoring with a hostile targetPath: rejected and the quarantine stays intact', () => {
  it.each(attacks().map(([name]) => [name]))('%s', async (name) => {
    const target = attacks().find(([n]) => n === name)![1];
    h.confirm.mockClear();
    await expect(
      h.manager.restore(item.id, { trustHash: false, targetPath: target }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    // Rejected before asking for confirmation and without writing anything.
    expect(h.confirm).not.toHaveBeenCalled();
    const record = h.record(item.id);
    expect(record.status).toBe('QUARANTINED');
    expect(record.restoredTo).toBeNull();
    expect(await exists(item.vaultFile)).toBe(true);
    expect((await fs.readdir(h.root)).sort()).toEqual(before);
    expect(h.manager.audit.list(item.id).at(-1)).toMatchObject({
      action: 'RESTORE_FAILED',
    });
  });

  it('relative paths (with or without ..) are rejected even if the current directory is valid', async () => {
    const cwd = process.cwd();
    process.chdir(h.root); // if accepted, they would land inside the test folder
    try {
      for (const target of [
        'fuera.txt',
        '.\\fuera.txt',
        '..\\fuera.txt',
        'sub/../fuera.txt',
        '',
      ]) {
        await expect(
          h.manager.restore(item.id, { trustHash: false, targetPath: target }),
        ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      }
    } finally {
      process.chdir(cwd);
    }
    expect((await fs.readdir(h.root)).sort()).toEqual(before);
    expect(h.record(item.id).status).toBe('QUARANTINED');
  });

  it('the tampered original path in the DB does not allow traversal either', async () => {
    const other = await h.seed('otra.txt');
    const second = await h.manager.quarantine(other.id);
    h.tamper(second.id, 'original_path', `${h.root}\\sub\\..\\otra.txt`);
    await expect(
      h.manager.restore(second.id, { trustHash: false }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(h.record(second.id).status).toBe('QUARANTINED');
    expect(await exists(second.vaultFile)).toBe(true);
  });

  it('after all attacks, a legitimate restoration returns the same SHA-256', async () => {
    const restored = await h.manager.restore(item.id, { trustHash: false });
    expect(restored.status).toBe('RESTORED');
    expect(restored.restoredTo).toBe(input.path);
    expect(sha(await fs.readFile(input.path))).toBe(input.hash);
  });
});

describe('validatePath: reserved Windows names', () => {
  it.each(['CON', 'prn.txt', 'Aux', 'nul.log', 'COM9', 'lpt1.txt'])(
    'rejects %s (already covered)',
    (name) => {
      expect(() => validatePath(`C:\\carpeta\\${name}`)).toThrow();
    },
  );
  // T4.3-A regression: Windows also reserves COM¹-COM³ and LPT¹-LPT³.
  // COM0 and LPT0 are conservatively rejected as ambiguous device names.
  // Only validation is checked: no file is created.
  for (const name of [
    'COM0',
    'LPT0',
    'COM¹',
    'COM²',
    'COM³',
    'LPT¹',
    'LPT²',
    'LPT³',
  ])
    it(`[FINDING A] rejects ${name} as a segment`, () => {
      expect(() => validatePath(`C:\\carpeta\\${name}.txt`)).toThrow();
    });
});

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedPaths, exists } from '../../src/core/quarantine/paths';
import { QuarantineHarness } from './harness';

vi.setConfig({ testTimeout: 20_000 });

describe('ProtectedPaths: format variations of system paths', () => {
  const paths = new ProtectedPaths([]);
  it.each([
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'c:\\windows\\x.txt',
    'C:\\WINDOWS\\X.TXT',
    'C:/Windows/x.txt',
    'C:\\Windows/System32\\x.dll',
    'C:\\\\Windows\\\\x.txt',
    'C:\\Windows\\\\\\x.txt',
    'C:\\Windows',
    'C:\\Windows\\',
    'c:\\windows\\.\\x.txt',
    'C:\\Users\\..\\Windows\\x.txt',
    'C:\\Program Files\\App\\app.exe',
    'c:/PROGRAM FILES/app/app.exe',
    'C:\\Program Files (x86)\\App\\app.exe',
    'C:\\PROGRAM FILES (X86)\\x',
    'C:\\ProgramData\\Microsoft\\Windows Defender\\x',
    'c:/programdata/MICROSOFT/x',
  ])('protege %s', (path) => {
    expect(() => paths.assertAllowed(path)).toThrow('protegida');
  });

  it.each([
    'C:\\Windows.old\\x.txt',
    'C:\\WindowsApps2\\x.txt',
    'C:\\Program Files Extra\\x',
    'C:\\ProgramData\\Microsoft2\\x',
    'C:\\ProgramData\\Otra\\x',
    'D:\\Windows\\x.txt',
  ])('does not confuse a name prefix with a protected folder: %s', (path) => {
    expect(() => paths.assertAllowed(path)).not.toThrow();
  });
});

describe('manager: real files in protected paths written in other ways', () => {
  let h: QuarantineHarness;
  beforeEach(async () => {
    h = new QuarantineHarness();
    await h.setup();
  });
  afterEach(() => h.close());

  /** Real file inside `protected/`, but the result stores the path in another format. */
  async function attempt(spelling: (path: string) => string) {
    const input = await h.seed('protected/muestra.txt');
    h.db
      .prepare('UPDATE scan_results SET path = ? WHERE id = ?')
      .run(spelling(input.path), input.id);
    const encrypt = vi.spyOn(h.vault, 'encrypt');
    await expect(h.manager.quarantine(input.id)).rejects.toMatchObject({
      code: expect.stringMatching(/^(PROTECTED_PATH|INVALID_PATH)$/),
    });
    expect(encrypt).not.toHaveBeenCalled();
    expect(await exists(input.path)).toBe(true);
    expect(h.manager.list()).toEqual([]);
    expect(await h.vaultFiles()).toEqual([]);
  }

  it.each([
    ['MAYÚSCULAS', (p: string) => p.toUpperCase()],
    ['minúsculas', (p: string) => p.toLowerCase()],
    ['barras normales', (p: string) => p.replaceAll('\\', '/')],
    ['barras dobles', (p: string) => p.replaceAll('\\', '\\\\')],
    [
      'segmento "."',
      (p: string) => p.replace('\\protected\\', '\\.\\protected\\'),
    ],
    [
      'con ..',
      (p: string) => p.replace('\\protected\\', '\\protected\\..\\protected\\'),
    ],
    [
      'punto final en la carpeta',
      (p: string) => p.replace('\\protected\\', '\\protected.\\'),
    ],
    [
      'espacio final en la carpeta',
      (p: string) => p.replace('\\protected\\', '\\protected \\'),
    ],
    ['prefijo \\\\?\\', (p: string) => `\\\\?\\${p}`],
    [
      'UNC por recurso administrativo',
      (p: string) => `\\\\localhost\\${p[0]}$${p.slice(2)}`,
    ],
  ])('rejected when written as %s', async (_name, spelling) => {
    await attempt(spelling);
  });

  it('rejected through an 8.3 short alias of the folder', async (context) => {
    // %TEMP% is usually C:\Users\NAME~1\...: the same folder under another name.
    const shortTemp = tmpdir();
    if ((await fs.realpath(shortTemp)) === shortTemp) {
      context.skip('Este equipo no expone %TEMP% con nombre corto 8.3.');
    }
    await attempt((p) =>
      join(shortTemp, basename(h.root), 'protected', basename(p)),
    );
  });

  it('restoring into a protected folder written in UPPERCASE, with / or with an 8.3 alias is rejected', async () => {
    const input = await h.seed('normal.txt');
    const item = await h.manager.quarantine(input.id);
    await fs.mkdir(join(h.root, 'protected'));
    const targets = [
      join(h.root, 'protected', 'x.txt').toUpperCase(),
      join(h.root, 'protected', 'x.txt').replaceAll('\\', '/'),
      join(h.vault.root, 'x.txt'),
      join(h.vault.root.toUpperCase(), 'x.txt'),
      h.vault.path(item.id),
    ];
    const shortTemp = tmpdir();
    if ((await fs.realpath(shortTemp)) !== shortTemp)
      targets.push(join(shortTemp, basename(h.root), 'protected', 'x.txt'));
    for (const targetPath of targets) {
      await expect(
        h.manager.restore(item.id, { trustHash: false, targetPath }),
      ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    }
    expect(await fs.readdir(join(h.root, 'protected'))).toEqual([]);
    expect(h.record(item.id).status).toBe('QUARANTINED');
    expect(await exists(item.vaultFile)).toBe(true);
  });

  it('restoring to C:\\PROGRA~1 (short alias of Program Files) is rejected before writing', async () => {
    const input = await h.seed('normal.txt');
    const item = await h.manager.quarantine(input.id);
    await expect(
      h.manager.restore(item.id, {
        trustHash: false,
        targetPath: 'C:\\PROGRA~1\\cybersoc-prueba-adversarial.txt',
      }),
    ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    expect(h.confirm).toHaveBeenCalledTimes(1); // only the quarantine one
    expect(h.record(item.id).status).toBe('QUARANTINED');
  });
});

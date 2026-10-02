import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteVerifiedOriginal } from '../../src/core/quarantine/OriginalFile';

const native = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => native);

beforeEach(() => {
  native.execFile.mockImplementation((...args: unknown[]) => {
    (args[3] as (error: Error | null) => void)(null);
  });
});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform !== 'win32')('auxiliar nativo aislado', () => {
  it('carga el módulo incorporado sin heredar secretos ni interpolar la ruta', async () => {
    vi.stubEnv('CYBERSOC_ANTHROPIC_API_KEY', 'secret-sentinel');
    vi.stubEnv('GITHUB_TOKEN', 'token-sentinel');
    vi.stubEnv('PSModulePath', 'C:\\untrusted-modules');
    const path = 'C:\\fixtures\\texto $(no-ejecutar).txt';
    const hash = 'a'.repeat(64);
    await deleteVerifiedOriginal(path, hash);
    const [executable, args, options] = native.execFile.mock.calls[0]! as [
      string,
      string[],
      { env: Record<string, string>; windowsHide: boolean; timeout: number },
    ];
    expect(executable).toMatch(
      /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/,
    );
    expect(args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    expect(script).toContain(
      'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop',
    );
    expect(script).not.toContain(path);
    expect(options.windowsHide).toBe(true);
    expect(options.env.CYBERSOC_DELETE_PATH).toBe(path);
    expect(options.env.CYBERSOC_DELETE_HASH).toBe(hash);
    expect(Object.keys(options.env).sort()).toEqual(
      [
        'SystemRoot',
        'TEMP',
        'TMP',
        'CYBERSOC_DELETE_PATH',
        'CYBERSOC_DELETE_HASH',
      ].sort(),
    );
    expect(JSON.stringify(options)).not.toMatch(
      /secret-sentinel|token-sentinel|untrusted-modules/,
    );
  });

  it.each([
    [3, 'FILE_CHANGED'],
    [4, 'DELETE_FAILED'],
    [5, 'DELETE_UNCERTAIN'],
    ['ETIMEDOUT', 'DELETE_UNCERTAIN'],
  ])(
    'mantiene el tratamiento conservador del error %s',
    async (code, expected) => {
      native.execFile.mockImplementation((...args: unknown[]) => {
        (args[3] as (error: unknown) => void)({ code });
      });
      await expect(
        deleteVerifiedOriginal('C:\\fixture.txt', 'a'.repeat(64)),
      ).rejects.toMatchObject({ code: expected });
    },
  );
});

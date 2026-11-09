import { expect, it, vi } from 'vitest';
import { windowsPowerShellPath } from '../src/main/windows-tools';

it('resolves the loaded OS PowerShell without obeying foreign PATH/SystemRoot', () => {
  vi.stubEnv('PATH', 'C:/fixture-malicioso');
  vi.stubEnv('SystemRoot', 'C:/fixture-malicioso');
  try {
    expect(
      windowsPowerShellPath([
        'D:\\Windows\\System32\\KERNEL32.DLL',
        'D:\\Windows\\System32\\ntdll.dll',
      ]),
    ).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(() => windowsPowerShellPath([])).toThrow('identificar');
    expect(() =>
      windowsPowerShellPath([
        'C:\\Windows\\System32\\kernel32.dll',
        'D:\\Windows\\System32\\ntdll.dll',
      ]),
    ).toThrow('identificar');
  } finally {
    vi.unstubAllEnvs();
  }
});

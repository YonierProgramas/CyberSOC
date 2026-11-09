import { describe, expect, it } from 'vitest';
import { anonymizeToolResult } from '../src/core/ai/anonymizeToolResult';

describe('anonymizeToolResult (AUD-04)', () => {
  it('anonymizes profile paths at any level and key', () => {
    const result = {
      ok: true,
      data: {
        job: { targetPath: 'C:\\Users\\maria.lopez\\Downloads' },
        rows: [
          {
            path: 'D:/Users/Maria.Lopez/Desktop/factura.pdf.exe',
            originalPath: '\\\\?\\C:\\Users\\maria.lopez\\AppData\\x.dll',
          },
        ],
        zones: [{ paths: ['C:\\Users\\maria.lopez\\Documents'] }],
      },
    };
    const sent = JSON.stringify(anonymizeToolResult(result));
    expect(sent).not.toMatch(/maria\.lopez/i);
    expect(anonymizeToolResult(result).data.job.targetPath).toBe(
      '%USERPROFILE%\\Downloads',
    );
    expect(anonymizeToolResult(result).data.rows[0]!.path).toBe(
      '%USERPROFILE%\\Desktop\\factura.pdf.exe',
    );
    expect(anonymizeToolResult(result).data.zones[0]!.paths[0]).toBe(
      '%USERPROFILE%\\Documents',
    );
  });

  it('does not touch texts that are not paths or paths without a personal profile', () => {
    const result = {
      reason: 'firma a/b conocida',
      date: '2026-11-05',
      sha256: 'ab'.repeat(32),
      shared: 'C:\\Users\\Public\\Documents\\nota.txt',
      program: 'C:\\Program Files\\App\\app.exe',
      count: 3,
      flag: null,
    };
    expect(anonymizeToolResult(result)).toEqual(result);
  });

  it('returns a copy: the original Core result does not change', () => {
    const result = { rows: [{ path: 'C:\\Users\\maria.lopez\\a.txt' }] };
    anonymizeToolResult(result);
    expect(result.rows[0]!.path).toBe('C:\\Users\\maria.lopez\\a.txt');
  });
});

import { describe, expect, it } from 'vitest';
import { anonymizeToolResult } from '../src/core/ai/anonymizeToolResult';

describe('anonymizeToolResult (AUD-04)', () => {
  it('anonimiza rutas del perfil en cualquier nivel y clave', () => {
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

  it('no toca textos que no son rutas ni rutas sin perfil personal', () => {
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

  it('devuelve una copia: el resultado original del Core no cambia', () => {
    const result = { rows: [{ path: 'C:\\Users\\maria.lopez\\a.txt' }] };
    anonymizeToolResult(result);
    expect(result.rows[0]!.path).toBe('C:\\Users\\maria.lopez\\a.txt');
  });
});

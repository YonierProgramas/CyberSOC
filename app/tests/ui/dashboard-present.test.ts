import { describe, expect, it } from 'vitest';
import type { VerdictDistributionDTO } from '../../src/shared/ipc';
import {
  activityTitle,
  barHeight,
  historyPageNotice,
  scopeNotice,
  verdictRows,
} from '../../src/renderer/src/dashboard/present';

function distribution(
  counts: VerdictDistributionDTO['results']['byVerdict'],
  total: number,
  excluded: number,
  partial: boolean,
): VerdictDistributionDTO {
  return {
    scope: 'RANGE',
    jobStatuses: ['COMPLETED'],
    range: { from: '2026-11-01', to: '2026-11-04' },
    jobs: 2,
    results: {
      total,
      byVerdict: counts,
      byStatus: { SCANNED: total, ERROR: 0, SKIPPED: 0 },
      byZone: [],
      byAiStatus: {
        NOT_REQUIRED: 0,
        PENDING: 0,
        RUNNING: 0,
        RETRY_WAIT: 0,
        COMPLETED: 0,
        UNAVAILABLE: 0,
        INVALID: 0,
        NOT_CONFIGURED: 0,
      },
    },
    excluded: {
      jobs: excluded === 0 ? 0 : 1,
      results: excluded,
      byJobStatus: {
        CREATED: 0,
        DISCOVERING: 0,
        SCANNING: 0,
        CANCELLING: 0,
        CANCELLED: 0,
        COMPLETED: 0,
        FAILED: excluded === 0 ? 0 : 1,
      },
    },
    partial,
  };
}

describe('presentación del resumen', () => {
  it('muestra cada veredicto del Core, incluido el cero y el no analizado', () => {
    const rows = verdictRows(
      distribution(
        {
          CLEAN: 3,
          SUSPICIOUS: 0,
          DETECTED: 1,
          NOT_ANALYZED: 2,
          NOT_EVALUATED: 0,
        },
        6,
        4,
        false,
      ),
    );
    expect(rows.map((row) => [row.label, row.count])).toEqual([
      ['Limpio', 3],
      ['Sospechoso', 0],
      ['Detectado', 1],
      ['No analizado', 2],
      ['Sin evaluar', 0],
    ]);
  });

  it('no presenta el cero como un ámbito limpio y separa los excluidos', () => {
    const text = scopeNotice(
      distribution(
        {
          CLEAN: 0,
          SUSPICIOUS: 0,
          DETECTED: 0,
          NOT_ANALYZED: 0,
          NOT_EVALUATED: 0,
        },
        0,
        0,
        true,
      ),
    );
    expect(text).toContain('No hay resultados');
    expect(text).toContain('Excluidos por estado dentro del rango: 0');
    expect(text).toContain('incompletas');
    expect(text).not.toContain('Limpio');
  });

  it.each([
    [
      'LAST_COMPLETED',
      'fallidos/cancelados posteriores al último completado',
      7,
    ],
    ['ALL_COMPLETED', 'análisis no completados', 7],
    ['RANGE', 'por estado dentro del rango', 0],
  ] as const)(
    'explica el universo de excluidos en %s sin alterar su cifra',
    (scope, label, excluded) => {
      const dto = distribution(
        {
          CLEAN: 2,
          SUSPICIOUS: 0,
          DETECTED: 0,
          NOT_ANALYZED: 0,
          NOT_EVALUATED: 0,
        },
        2,
        excluded,
        false,
      );
      dto.scope = scope;
      expect(scopeNotice(dto)).toContain(label);
      expect(scopeNotice(dto)).toContain(`${excluded} resultados`);
      expect(scopeNotice(dto)).toContain('2 resultados en este ámbito');
    },
  );

  it('distingue siete días de otro rango y una página del historial completo', () => {
    expect(
      activityTitle({
        range: { from: '2026-10-29', to: '2026-11-04', days: 7 },
      } as never),
    ).toBe('Actividad de siete días');
    expect(
      activityTitle({
        range: { from: '2026-11-01', to: '2026-11-04', days: 4 },
      } as never),
    ).toBe('Actividad de 4 días');
    expect(historyPageNotice(20, 20, 45)).toBe(
      'Análisis 21–40 de 45. Esta página no es todo el historial.',
    );
    expect(historyPageNotice(0, 3, 3)).toBe('Análisis 1–3 de 3.');
    expect(historyPageNotice(0, 0, 0)).toBe('No hay análisis guardados.');
  });

  it('un cero no dibuja una barra y el máximo usa la cifra recibida', () => {
    expect(barHeight(0, 8)).toBe(0);
    expect(barHeight(4, 8)).toBe(50);
    expect(barHeight(4, 0)).toBe(0);
  });
});

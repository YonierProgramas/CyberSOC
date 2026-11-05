import { describe, expect, it } from 'vitest';
import {
  readMetrics,
  skippedNotice,
  verdictLabel,
} from '../../src/renderer/src/scan/format';

describe('métricas del trabajo: entradas omitidas (AUD-10)', () => {
  it('lee skippedEntries y tolera métricas antiguas o corruptas', () => {
    expect(
      readMetrics(JSON.stringify({ skippedEntries: 3 })).skippedEntries,
    ).toBe(3);
    expect(
      readMetrics(JSON.stringify({ peakStackSize: 2 })).skippedEntries,
    ).toBe(null);
    expect(readMetrics('{no es json').skippedEntries).toBe(null);
    expect(readMetrics(null).skippedEntries).toBe(null);
  });

  it('solo avisa cuando hubo omisiones, con singular y plural', () => {
    const base = readMetrics(null);
    expect(skippedNotice(base)).toBe(null);
    expect(skippedNotice({ ...base, skippedEntries: 0 })).toBe(null);
    expect(skippedNotice({ ...base, skippedEntries: 1 })).toContain(
      'No se pudieron leer 1 entrada ',
    );
    const many = skippedNotice({ ...base, skippedEntries: 12 });
    expect(many).toContain('12 entradas');
    expect(many).toContain('no se analizó completa');
  });
});

describe('etiqueta de veredicto (AUD-11)', () => {
  it('CLEAN se presenta como «Sin hallazgos», no como seguro', () => {
    expect(verdictLabel('CLEAN')).toBe('Sin hallazgos');
    expect(verdictLabel('DETECTED')).toBe('Detectado');
  });
});

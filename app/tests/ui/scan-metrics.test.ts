import { describe, expect, it } from 'vitest';
import {
  readMetrics,
  skippedNotice,
  verdictLabel,
} from '../../src/renderer/src/scan/format';

describe('job metrics: skipped entries (AUD-10)', () => {
  it('reads skippedEntries and tolerates old or corrupt metrics', () => {
    expect(
      readMetrics(JSON.stringify({ skippedEntries: 3 })).skippedEntries,
    ).toBe(3);
    expect(
      readMetrics(JSON.stringify({ peakStackSize: 2 })).skippedEntries,
    ).toBe(null);
    expect(readMetrics('{no es json').skippedEntries).toBe(null);
    expect(readMetrics(null).skippedEntries).toBe(null);
  });

  it('only warns when there were skips, with singular and plural', () => {
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

describe('verdict label (AUD-11)', () => {
  it('CLEAN is presented as «Sin hallazgos», not as safe', () => {
    expect(verdictLabel('CLEAN')).toBe('Sin hallazgos');
    expect(verdictLabel('DETECTED')).toBe('Detectado');
  });
});

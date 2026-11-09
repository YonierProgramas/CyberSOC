import { expect, it } from 'vitest';
import { engineResultSchema } from '../src/shared/protocol';

const base = {
  taskId: 't',
  status: 'SCANNED',
  evidence: [],
  layers: [],
  durationMs: 0,
  engineVersion: 'test',
};

it('keeps earlier responses without fabricating an assessment', () => {
  expect(engineResultSchema.parse(base)).toEqual(base);
});

it.each([
  ['CLEAN', 0, 'BAJO'],
  ['CLEAN', 29, 'BAJO'],
  ['SUSPICIOUS', 30, 'MEDIO'],
  ['SUSPICIOUS', 59, 'MEDIO'],
  ['SUSPICIOUS', 60, 'ALTO'],
  ['SUSPICIOUS', 84, 'ALTO'],
  ['SUSPICIOUS', 85, 'CRÍTICO'],
  ['DETECTED', 85, 'CRÍTICO'],
  ['DETECTED', 100, 'CRÍTICO'],
  ['ERROR', null, null],
  ['NOT_ANALYZED', null, null],
])('accepts assessment %s/%j/%s', (verdict, score, riskLevel) => {
  const value = { ...base, verdict, score, riskLevel };
  expect(engineResultSchema.parse(value)).toEqual(value);
});

it.each([
  ['CLEAN', null, null],
  ['CLEAN', 30, 'MEDIO'],
  ['SUSPICIOUS', 29, 'BAJO'],
  ['DETECTED', 84, 'ALTO'],
  ['CLEAN', 0, 'MEDIO'],
  ['DETECTED', 85, 'ALTO'],
  ['ERROR', 0, 'BAJO'],
  ['NOT_ANALYZED', 0, 'BAJO'],
  ['CLEAN', 1.5, 'BAJO'],
  ['CLEAN', -1, 'BAJO'],
  ['DETECTED', 101, 'CRÍTICO'],
  ['CLEAN', true, 'BAJO'],
  ['CLEAN', '0', 'BAJO'],
  ['CLEAN', Infinity, 'BAJO'],
  [null, null, null],
  ['UNKNOWN', 0, 'BAJO'],
  ['DETECTED', 85, 'CRITICO'],
])('rejects incoherent assessment %s/%j/%s', (verdict, score, riskLevel) => {
  expect(
    engineResultSchema.safeParse({ ...base, verdict, score, riskLevel })
      .success,
  ).toBe(false);
});

it.each(['verdict', 'score', 'riskLevel'])(
  'rejects partial assessment without %s',
  (field) => {
    const value: Record<string, unknown> = {
      ...base,
      verdict: 'CLEAN',
      score: 0,
      riskLevel: 'BAJO',
    };
    delete value[field];
    expect(engineResultSchema.safeParse(value).success).toBe(false);
  },
);

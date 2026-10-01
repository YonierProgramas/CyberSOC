import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { scanFileResponseSchema } from '../src/shared/protocol';

const example = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/protocol-v1/scan.file.response.score-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
it.each([
  ['heuristics', 'raw', 101],
  ['heuristics', 'cap', 60],
  ['heuristics', 'capped', 51],
  ['rules', 'capped', 61],
  ['signatures', 'cap', 50],
])('rechaza un grupo inconsistente: %s.%s=%s', (group, key, value) => {
  const bad = structuredClone(example);
  bad.result.scoreBreakdown[group][key] = value;
  expect(scanFileResponseSchema.safeParse(bad).success).toBe(false);
});
it.each(['rawTotal', 'cappedTotal', 'total', 'decisiveFloor'])(
  'rechaza desglose inconsistente en %s',
  (key) => {
    const bad = structuredClone(example);
    bad.result.scoreBreakdown[key] = 99;
    expect(scanFileResponseSchema.safeParse(bad).success).toBe(false);
  },
);
it('rechaza puntuación o veredicto que contradiga el desglose', () => {
  for (const change of [{ score: 99 }, { verdict: 'DETECTED' }]) {
    const bad = structuredClone(example);
    Object.assign(bad.result, change);
    expect(scanFileResponseSchema.safeParse(bad).success).toBe(false);
  }
});

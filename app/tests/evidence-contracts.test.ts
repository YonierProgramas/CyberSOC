import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  evidenceSchema,
  layerTraceSchema,
  scanFileResponseSchema,
  statsRequestSchema,
  statsResponseSchema,
} from '../src/shared/protocol';

function load(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`../../contracts/protocol-v1/${name}`, import.meta.url),
      'utf8',
    ),
  );
}
const scan = scanFileResponseSchema.parse(
  load('scan.file.response.double-extension.json'),
);
const evidence = scan.result.evidence[0]!;
const trace = scan.result.layers[2]!;

it.each([
  ['id', 'ev0'],
  ['id', 'ev1\n'],
  ['source', 'HASH'],
  ['source', 'UNKNOWN'],
  ['severity', 'SEVERE'],
  ['code', ''],
  ['title', ''],
  ['points', -1],
  ['points', 1.5],
  ['points', '25'],
  ['points', true],
  ['points', 9007199254740992],
  ['confidence', -0.01],
  ['confidence', 1.01],
  ['confidence', '0.8'],
  ['confidence', true],
  ['confidence', Infinity],
  ['decisive', 1],
  ['decisive', 'false'],
  ['facts', []],
  ['facts', 'text'],
  ['extra', 1],
])('rechaza evidencia inválida %s=%j', (field, value) => {
  expect(
    evidenceSchema.safeParse({ ...evidence, [field]: value }).success,
  ).toBe(false);
});

it.each([
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
  'ENGINE',
])('acepta la fuente %s', (source) => {
  expect(evidenceSchema.safeParse({ ...evidence, source }).success).toBe(true);
});
it.each(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])(
  'acepta la severidad %s',
  (severity) => {
    expect(evidenceSchema.safeParse({ ...evidence, severity }).success).toBe(
      true,
    );
  },
);
it('conserva hechos JSON anidados y confianza en ambos límites', () => {
  for (const confidence of [0, 1]) {
    const value = {
      ...evidence,
      confidence,
      facts: { nested: { values: [null, true, 2, 'texto'] } },
    };
    expect(evidenceSchema.parse(value)).toEqual(value);
  }
  expect(evidenceSchema.parse({ ...evidence, facts: {} }).facts).toEqual({});
});

it.each([
  ['layer', 'ENGINE'],
  ['layer', 'UNKNOWN'],
  ['status', 'DONE'],
  ['hits', -1],
  ['hits', 0.5],
  ['hits', true],
  ['hits', '1'],
  ['points', -1],
  ['points', 0.5],
  ['points', true],
  ['points', '25'],
  ['ms', -1],
  ['ms', true],
  ['ms', '1'],
  ['ms', Infinity],
  ['reason', null],
  ['reason', ''],
  ['reason', '   '],
  ['extra', 1],
])('rechaza traza inválida %s=%j', (field, value) => {
  expect(layerTraceSchema.safeParse({ ...trace, [field]: value }).success).toBe(
    false,
  );
});
it.each([
  'HASH',
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
])('acepta la capa %s', (layer) => {
  expect(layerTraceSchema.safeParse({ ...trace, layer }).success).toBe(true);
});
it.each(['RAN', 'SKIPPED', 'DISABLED', 'ERROR'])(
  'acepta el estado %s y exige motivo para SKIPPED/DISABLED',
  (status) => {
    expect(
      layerTraceSchema.safeParse({
        ...trace,
        status,
        reason: 'NOT_APPLICABLE',
        ms: status === 'DISABLED' ? 0 : 0.25,
        hits: status === 'DISABLED' ? 0 : trace.hits,
        points: status === 'DISABLED' ? 0 : trace.points,
      }).success,
    ).toBe(true);
    expect(layerTraceSchema.safeParse({ ...trace, status }).success).toBe(
      !['SKIPPED', 'DISABLED'].includes(status),
    );
  },
);
it('rechaza capas repetidas y HASH desactivada', () => {
  const value = structuredClone(scan);
  value.result.layers.push(value.result.layers[0]!);
  expect(scanFileResponseSchema.safeParse(value).success).toBe(false);
  expect(
    layerTraceSchema.safeParse({ ...trace, layer: 'HASH', status: 'DISABLED' })
      .success,
  ).toBe(false);
});
it.each([-1, 1.5, true, '5', null, 9007199254740992])(
  'rechaza signaturesCount inválido: %j',
  (signaturesCount) => {
    const value = load('engine.stats.response.json');
    value.result.signaturesCount = signaturesCount;
    expect(statsResponseSchema.safeParse(value).success).toBe(false);
  },
);
it('engine.stats acepta cero firmas y rechaza método, versiones y parámetros inválidos', () => {
  const value = load('engine.stats.response.json');
  value.result.signaturesCount = 0;
  expect(statsResponseSchema.safeParse(value).success).toBe(true);
  for (const field of [
    'engineVersion',
    'signaturesVersion',
    'rulesetVersion',
  ]) {
    expect(
      statsResponseSchema.safeParse({
        ...value,
        result: { ...value.result, [field]: '' },
      }).success,
    ).toBe(false);
  }
  const request = load('engine.stats.request.json');
  expect(
    statsRequestSchema.safeParse({ ...request, method: 'stats' }).success,
  ).toBe(false);
  expect(
    statsRequestSchema.safeParse({ ...request, params: { extra: true } })
      .success,
  ).toBe(false);
});
it('los ejemplos distinguen firma decisiva de una heurística sin decidir el veredicto', () => {
  const signature = scanFileResponseSchema.parse(
    load('scan.file.response.detected-signature.json'),
  );
  expect(signature.result.evidence[0]!.decisive).toBe(true);
  expect(signature.result.evidence[0]!.source).toBe('SIGNATURES');
  expect(evidence.decisive).toBe(false);
  expect(evidence.points).toBe(25);
  expect(scan.result.verdict).toBe('CLEAN');
  expect(scan.result.score).toBe(25);
});

it.each([0, 1.0, Number.MAX_SAFE_INTEGER])(
  'acepta enteros JSON representables: %j',
  (count) => {
    const stats = load('engine.stats.response.json');
    stats.result.signaturesCount = count;
    expect(statsResponseSchema.safeParse(stats).success).toBe(true);
    expect(
      evidenceSchema.safeParse({ ...evidence, points: count }).success,
    ).toBe(true);
    expect(
      layerTraceSchema.safeParse({ ...trace, hits: count, points: count })
        .success,
    ).toBe(true);
  },
);

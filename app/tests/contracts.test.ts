import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  helloRequestSchema,
  helloResponseSchema,
  pingRequestSchema,
  pingResponseSchema,
  shutdownRequestSchema,
  shutdownResponseSchema,
  methodNotFoundResponseSchema,
  parseErrorResponseSchema,
  scanFileRequestSchema,
  scanFileResponseSchema,
  driveInfoRequestSchema,
  driveInfoResponseSchema,
  rulesReloadRequestSchema,
  rulesReloadResponseSchema,
  statsRequestSchema,
  statsResponseSchema,
} from '../src/shared/protocol';

const directory = fileURLToPath(
  new URL('../../contracts/protocol-v1/', import.meta.url),
);
const schemas = {
  'engine.hello.request.json': helloRequestSchema,
  'engine.hello.response.json': helloResponseSchema,
  'engine.ping.request.json': pingRequestSchema,
  'engine.ping.response.json': pingResponseSchema,
  'engine.shutdown.request.json': shutdownRequestSchema,
  'engine.shutdown.response.json': shutdownResponseSchema,
  'error.method-not-found.json': methodNotFoundResponseSchema,
  'error.parse-error.json': parseErrorResponseSchema,
  'scan.file.request.zone-layers.json': scanFileRequestSchema,
  'scan.file.request.mandatory-only.json': scanFileRequestSchema,
  'scan.file.response.disabled-layers.json': scanFileResponseSchema,
  'fs.driveInfo.request.json': driveInfoRequestSchema,
  'fs.driveInfo.response.json': driveInfoResponseSchema,
  'scan.file.request.json': scanFileRequestSchema,
  'scan.file.response.scanned.json': scanFileResponseSchema,
  'scan.file.response.error-access-denied.json': scanFileResponseSchema,
  'scan.file.response.skipped-cloud.json': scanFileResponseSchema,
  'scan.file.response.skipped-too-large.json': scanFileResponseSchema,
  'scan.file.response.detected-signature.json': scanFileResponseSchema,
  'scan.file.response.double-extension.json': scanFileResponseSchema,
  'rules.reload.request.json': rulesReloadRequestSchema,
  'rules.reload.response.json': rulesReloadResponseSchema,
  'engine.stats.request.json': statsRequestSchema,
  'engine.stats.response.json': statsResponseSchema,
};

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
}

function fieldPaths(
  object: Record<string, unknown>,
  prefix: string[] = [],
): string[][] {
  return Object.entries(object).flatMap(([key, value]) => {
    const path = [...prefix, key];
    // facts es un diccionario abierto: sus claves particulares no son obligatorias.
    if (key === 'facts') return [path];
    return [
      path,
      ...(Array.isArray(value)
        ? value.flatMap((item, index) =>
            item !== null && typeof item === 'object'
              ? fieldPaths(item, [...path, String(index)])
              : [],
          )
        : value !== null && typeof value === 'object'
          ? fieldPaths(value as Record<string, unknown>, path)
          : []),
    ];
  });
}

function mutate(
  example: Record<string, unknown>,
  path: string[],
  change: 'delete' | 'type',
) {
  const copy = structuredClone(example);
  const keys = [...path];
  const key = keys.pop()!;
  const parent = keys.reduce(
    (value, part) => value[part] as Record<string, unknown>,
    copy,
  );
  if (change === 'delete') delete parent[key];
  else
    parent[key] = ['id', 'extension', 'score', 'riskLevel'].includes(key)
      ? true
      : null;
  return copy;
}

it('valida todos los archivos compartidos sin dejar ejemplos sin esquema', () => {
  expect(readdirSync(directory).sort()).toEqual(Object.keys(schemas).sort());
});

for (const [name, schema] of Object.entries(schemas)) {
  describe(name, () => {
    const example = load(name);
    it('acepta el ejemplo en disco sin convertir ni eliminar campos', () => {
      expect(schema.parse(example)).toEqual(example);
    });
    for (const path of fieldPaths(example)) {
      const optional =
        ['params.options.zone', 'params.options.layers'].includes(
          path.join('.'),
        ) ||
        (name.startsWith('scan.file.response.') &&
          ['result.file', 'result.hashes', 'result.error'].includes(
            path.join('.'),
          ));
      if (!optional) {
        it(`rechaza eliminar ${path.join('.')}`, () => {
          expect(
            schema.safeParse(mutate(example, path, 'delete')).success,
          ).toBe(false);
        });
      }
      it(`rechaza tipo incorrecto en ${path.join('.')}`, () => {
        expect(schema.safeParse(mutate(example, path, 'type')).success).toBe(
          false,
        );
      });
    }
    it('rechaza versiones de JSON-RPC distintas de 2.0', () => {
      expect(schema.safeParse({ ...example, jsonrpc: '1.0' }).success).toBe(
        false,
      );
    });
    it('rechaza mezclar peticion, resultado y error', () => {
      const extra =
        'method' in example
          ? { result: {} }
          : 'result' in example
            ? { error: { code: -32603, message: 'Internal error' } }
            : { result: {} };
      expect(schema.safeParse({ ...example, ...extra }).success).toBe(false);
    });
  });
}

it.each([
  'engine.hello',
  'engine.ping',
  'engine.shutdown',
  'engine.stats',
] as const)('%s conserva el id de la peticion', (method) => {
  expect(load(`${method}.response.json`).id).toEqual(
    load(`${method}.request.json`).id,
  );
});

it.each([1, '2', 2])('rechaza protocolo incompatible %s', (protocol) => {
  expect(
    helloRequestSchema.safeParse({
      ...load('engine.hello.request.json'),
      params: { protocol, client: 'cybersoc-core/0.0.1' },
    }).success,
  ).toBe(false);
  const example = load('engine.hello.response.json');
  expect(
    helloResponseSchema.safeParse({
      ...example,
      result: { ...(example.result as object), protocol },
    }).success,
  ).toBe(false);
});

it.each([
  '2026-02-30T15:00:00Z',
  '2026-10-01',
  '2026-10-01T15:00:00',
  '2026-10-01T15:00:00+00:00',
  '2026-10-01T15:00Z',
  '2026-10-01T25:00:00Z',
])('rechaza timestamp %s', (ts) => {
  expect(
    pingResponseSchema.safeParse({
      ...load('engine.ping.response.json'),
      result: { ts },
    }).success,
  ).toBe(false);
});

it.each([false, 1, 'true'])('shutdown exige true booleano: %s', (ok) => {
  expect(
    shutdownResponseSchema.safeParse({
      ...load('engine.shutdown.response.json'),
      result: { ok },
    }).success,
  ).toBe(false);
});

it('rechaza metodos, parametros, capacidades y codigos incorrectos', () => {
  expect(
    pingRequestSchema.safeParse({
      ...load('engine.ping.request.json'),
      method: 'unknown',
    }).success,
  ).toBe(false);
  expect(
    shutdownRequestSchema.safeParse({
      ...load('engine.shutdown.request.json'),
      params: { extra: 1 },
    }).success,
  ).toBe(false);
  const hello = load('engine.hello.response.json');
  expect(
    helloResponseSchema.safeParse({
      ...hello,
      result: { ...(hello.result as object), capabilities: [1] },
    }).success,
  ).toBe(false);
  expect(
    methodNotFoundResponseSchema.safeParse({
      ...load('error.method-not-found.json'),
      error: { code: -32700, message: 'Parse error' },
    }).success,
  ).toBe(false);
  expect(
    parseErrorResponseSchema.safeParse({
      ...load('error.parse-error.json'),
      id: 1,
    }).success,
  ).toBe(false);
});

import { readFileSync } from 'node:fs';
import { expect, expectTypeOf, it } from 'vitest';
import type {
  FileErrorCode,
  FileScanStatus,
  FileTask,
} from '../src/core/domain/types';
import {
  engineResultSchema,
  fileErrorCodeSchema,
  fileScanStatusSchema,
  scanFileParamsSchema,
  scanFileRequestSchema,
  scanFileResponseSchema,
} from '../src/shared/protocol';

function load(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../contracts/protocol-v1/${name}`, import.meta.url),
      'utf8',
    ),
  );
}

const request = scanFileRequestSchema.parse(load('scan.file.request.json'));
const scanned = scanFileResponseSchema.parse(
  load('scan.file.response.scanned.json'),
);
const statuses = ['SCANNED', 'ERROR', 'SKIPPED'] as const;
const codes = [
  'FILE_NOT_FOUND',
  'ACCESS_DENIED',
  'FILE_LOCKED',
  'IO_ERROR',
  'TOO_LARGE',
  'CLOUD_PLACEHOLDER',
  'TIMEOUT',
  'ENGINE_CRASHED',
] as const;

it('mantiene los tipos del dominio y los enums exactos del plan', () => {
  expectTypeOf<FileScanStatus>().toEqualTypeOf<(typeof statuses)[number]>();
  expectTypeOf<FileErrorCode>().toEqualTypeOf<(typeof codes)[number]>();
  expectTypeOf<FileTask>().toEqualTypeOf<{
    jobId: string;
    taskId: string;
    seq: number;
    path: string;
  }>();
  expect(fileScanStatusSchema.options).toEqual(statuses);
  expect(fileErrorCodeSchema.options).toEqual(codes);
});

it('conserva correlacion, Unicode y evidencia vacia sin veredicto en S1', () => {
  expect(scanned.id).toBe(request.id);
  expect(scanned.result.taskId).toBe(request.params.taskId);
  expect(scanned.result.file!.name).toContain('ñ');
  expect(scanned.result.file!.name).toContain('ó');
  expect(request.params.path.endsWith(scanned.result.file!.name)).toBe(true);
  expect(scanned.result.evidence).toEqual([]);
  expect(scanned.result).not.toHaveProperty('verdict');
});

it.each([
  ['error-access-denied', 'ERROR', 'ACCESS_DENIED'],
  ['skipped-cloud', 'SKIPPED', 'CLOUD_PLACEHOLDER'],
  ['skipped-too-large', 'SKIPPED', 'TOO_LARGE'],
])(
  'representa %s como resultado de archivo, no error RPC',
  (suffix, status, code) => {
    const value = scanFileResponseSchema.parse(
      load(`scan.file.response.${suffix}.json`),
    );
    expect(value.result.status).toBe(status);
    expect(value.result.error?.code).toBe(code);
    expect(value.result.evidence).toEqual([]);
    expect(value).not.toHaveProperty('error');
  },
);

it.each(statuses)(
  'respeta los campos opcionales del resultado %s',
  (status) => {
    const result = {
      taskId: 't_1',
      status,
      evidence: [],
      durationMs: 0,
      engineVersion: '0.1.0',
    };
    expect(engineResultSchema.parse(result)).toEqual(result);
  },
);

it('acepta extension nula pero exige la propiedad', () => {
  const file = { ...scanned.result.file!, extension: null };
  expect(
    engineResultSchema.parse({ ...scanned.result, file }).file?.extension,
  ).toBeNull();
});

it.each(['file', 'hashes', 'error'])(
  'rechaza null explicito en %s',
  (field) => {
    expect(
      engineResultSchema.safeParse({ ...scanned.result, [field]: null })
        .success,
    ).toBe(false);
  },
);

it.each(codes)('acepta el codigo de archivo %s', (code) => {
  expect(
    engineResultSchema.safeParse({
      ...scanned.result,
      error: { code, message: 'Error de prueba' },
    }).success,
  ).toBe(true);
});

it.each(['CLEAN', 'NOT_EVALUATED', '', 1, null])(
  'rechaza estado fuera del contrato: %s',
  (status) => {
    expect(
      engineResultSchema.safeParse({ ...scanned.result, status }).success,
    ).toBe(false);
  },
);

it.each(['UNKNOWN', -32603, null])(
  'rechaza codigo de archivo fuera del contrato: %s',
  (code) => {
    expect(
      engineResultSchema.safeParse({
        ...scanned.result,
        error: { code, message: 'Error' },
      }).success,
    ).toBe(false);
  },
);

it.each([
  '<64 hex>',
  'a'.repeat(63),
  'g'.repeat(64),
  'a'.repeat(65),
  'a'.repeat(64) + '\n',
])('rechaza SHA-256 mal formado: %s', (sha256) => {
  expect(
    engineResultSchema.safeParse({ ...scanned.result, hashes: { sha256 } })
      .success,
  ).toBe(false);
});

it.each([true, '512', null])('no convierte tipos numericos: %s', (value) => {
  expect(
    scanFileParamsSchema.safeParse({
      ...request.params,
      options: { maxBytes: value },
    }).success,
  ).toBe(false);
  expect(
    engineResultSchema.safeParse({ ...scanned.result, durationMs: value })
      .success,
  ).toBe(false);
  expect(
    engineResultSchema.safeParse({
      ...scanned.result,
      file: { ...scanned.result.file, sizeBytes: value },
    }).success,
  ).toBe(false);
});

it('rechaza opciones y propiedades no acordadas', () => {
  expect(
    scanFileParamsSchema.safeParse({
      ...request.params,
      options: { maxBytes: 1, layers: [] },
    }).success,
  ).toBe(false);
  expect(
    engineResultSchema.safeParse({ ...scanned.result, verdict: 'CLEAN' })
      .success,
  ).toBe(false);
  expect(
    engineResultSchema.safeParse({
      ...scanned.result,
      file: { ...scanned.result.file, extra: true },
    }).success,
  ).toBe(false);
  expect(
    scanFileRequestSchema.safeParse({ ...request, method: 'scan.folder' })
      .success,
  ).toBe(false);
});

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

it('keeps the domain types and exact plan enums', () => {
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

it('keeps correlation, Unicode and empty evidence without a verdict in S1', () => {
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
  'represents %s as a file result, not an RPC error',
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

it.each(statuses)('respects the optional fields of result %s', (status) => {
  const result = {
    taskId: 't_1',
    status,
    evidence: [],
    layers: [],
    durationMs: 0,
    engineVersion: '0.1.0',
  };
  expect(engineResultSchema.parse(result)).toEqual(result);
});

it('accepts a null extension but requires the property', () => {
  const file = { ...scanned.result.file!, extension: null };
  expect(
    engineResultSchema.parse({ ...scanned.result, file }).file?.extension,
  ).toBeNull();
});

it.each(['file', 'hashes', 'error'])('rejects explicit null in %s', (field) => {
  expect(
    engineResultSchema.safeParse({ ...scanned.result, [field]: null }).success,
  ).toBe(false);
});

it.each(codes)('accepts file code %s', (code) => {
  expect(
    engineResultSchema.safeParse({
      ...scanned.result,
      error: { code, message: 'Error de prueba' },
    }).success,
  ).toBe(true);
});

it.each(['CLEAN', 'NOT_EVALUATED', '', 1, null])(
  'rejects status outside the contract: %s',
  (status) => {
    expect(
      engineResultSchema.safeParse({ ...scanned.result, status }).success,
    ).toBe(false);
  },
);

it.each(['UNKNOWN', -32603, null])(
  'rejects file code outside the contract: %s',
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
])('rejects malformed SHA-256: %s', (sha256) => {
  expect(
    engineResultSchema.safeParse({ ...scanned.result, hashes: { sha256 } })
      .success,
  ).toBe(false);
});

it.each([true, '512', null])('does not convert numeric types: %s', (value) => {
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

it('rejects unagreed options and properties', () => {
  expect(
    scanFileParamsSchema.safeParse({
      ...request.params,
      options: { maxBytes: 1, unknownOption: [] },
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

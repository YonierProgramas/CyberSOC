import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parse, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  scanFileParamsSchema,
  layerTraceSchema,
  zoneSchema,
  driveInfoRequestSchema,
  driveInfoResponseSchema,
  scanFileResponseSchema,
} from '../src/shared/protocol';

const params = {
  jobId: 'j',
  taskId: 't',
  path: 'C:\\archivo.txt',
  options: { maxBytes: 1024 },
};
it.each(zoneSchema.options)(
  'acepta zona %s sin obligar a enviar capas',
  (zone) => {
    const value = { ...params, options: { maxBytes: 1024, zone } };
    expect(scanFileParamsSchema.parse(value)).toEqual(value);
  },
);
it.each([
  {},
  { layers: [] },
  { layers: ['FILETYPE'] },
  { layers: ['FILETYPE', 'SIGNATURES', 'HASH'] },
])('acepta opciones compatibles %j', (options) => {
  const value = { ...params, options: { maxBytes: 1024, ...options } };
  expect(scanFileParamsSchema.parse(value)).toEqual(value);
});
it.each([
  { zone: null },
  { zone: 'SYSTEM' },
  { zone: 1 },
  { zone: '' },
  { layers: null },
  { layers: 'HASH' },
  { layers: ['OTHER'] },
  { layers: [1] },
  { layers: ['HASH', 'HASH'] },
  { layers: ['ENGINE'] },
])('rechaza opciones fuera del contrato: %j', (options) => {
  expect(
    scanFileParamsSchema.safeParse({
      ...params,
      options: { maxBytes: 1024, ...options },
    }).success,
  ).toBe(false);
});
it.each([
  { layer: 'HASH' },
  { layer: 'SIGNATURES' },
  { reason: null },
  { reason: ' ' },
  { hits: 1 },
  { points: 1 },
])('rechaza traza DISABLED inconsistente: %j', (change) => {
  expect(
    layerTraceSchema.safeParse({
      layer: 'FILETYPE',
      status: 'DISABLED',
      reason: 'PROFILE_DISABLED',
      hits: 0,
      points: 0,
      ms: 0,
      ...change,
    }).success,
  ).toBe(false);
});
it.each(['FIXED', 'REMOVABLE', 'NETWORK', 'CDROM', 'UNKNOWN'])(
  'acepta tipo de unidad %s',
  (driveType) => {
    expect(
      driveInfoResponseSchema.parse({
        jsonrpc: '2.0',
        id: 1,
        result: { driveType },
      }).result.driveType,
    ).toBe(driveType);
  },
);
it.each(['USB', 'RAMDISK', '', 1, null])(
  'rechaza tipo de unidad %j',
  (driveType) => {
    expect(
      driveInfoResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        result: { driveType },
      }).success,
    ).toBe(false);
  },
);
it.each([
  {},
  [],
  { path: null },
  { path: 1 },
  { path: '' },
  { path: 'C:\u0000' },
  { path: 'C:\\', extra: true },
])('rechaza parámetros fs.driveInfo %j', (value) => {
  expect(
    driveInfoRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      method: 'fs.driveInfo',
      params: value,
    }).success,
  ).toBe(false);
});

const python = resolve(
  '..',
  'engine',
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
it.skipIf(!existsSync(python))(
  'motor real y zod: perfil mínimo conserva HASH/SIGNATURES y fs.driveInfo responde',
  () => {
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'scan.file',
        params: {
          ...params,
          path: resolve('../contracts/protocol-v1/scan.file.request.json'),
          options: { maxBytes: 1024 * 1024, zone: 'OTRA', layers: [] },
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'fs.driveInfo',
        params: {
          path:
            process.platform === 'win32' ? parse(process.cwd()).root : 'C:\\',
        },
      },
    ];
    const child = spawnSync(python, ['-m', 'cybersoc_engine'], {
      input:
        messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: resolve('../engine/src') },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const responses = child.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as unknown);
    expect(responses).toHaveLength(2);
    const result = scanFileResponseSchema.parse(responses[0]);
    expect(result.id).toBe(1);
    expect(
      result.result.layers.map(({ layer, status }) => [layer, status]),
    ).toEqual([
      ['HASH', 'RAN'],
      ['SIGNATURES', 'RAN'],
      ['FILETYPE', 'DISABLED'],
    ]);
    expect(result.result.hashes?.sha256).toHaveLength(64);
    const info = driveInfoResponseSchema.parse(responses[1]);
    expect(info.id).toBe(2);
    if (process.platform === 'win32')
      expect(info.result.driveType).not.toBe('UNKNOWN');
    else expect(info.result.driveType).toBe('UNKNOWN');
  },
);

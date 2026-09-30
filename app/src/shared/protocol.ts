import { z } from 'zod';

export const rpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const envelope = { jsonrpc: z.literal('2.0'), id: rpcIdSchema };
const emptyParamsSchema = z.strictObject({});

// Canonical v1 exchanges include id and params; the server also accepts notifications.
export const helloRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('engine.hello'),
  params: z.strictObject({ protocol: z.literal('1'), client: z.string() }),
});
export const pingRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('engine.ping'),
  params: emptyParamsSchema,
});
export const shutdownRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('engine.shutdown'),
  params: emptyParamsSchema,
});
export const statsRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('engine.stats'),
  params: emptyParamsSchema,
});
export const statsResultSchema = z.strictObject({
  engineVersion: z.string().min(1),
  signaturesVersion: z.string().min(1),
  signaturesCount: z.number().int().nonnegative(),
});
export const statsResponseSchema = z.strictObject({
  ...envelope,
  result: statsResultSchema,
});
export type StatsRequest = z.infer<typeof statsRequestSchema>;
export type StatsResult = z.infer<typeof statsResultSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;

export const helloResultSchema = z.strictObject({
  protocol: z.literal('1'),
  engineVersion: z.string(),
  python: z.string(),
  capabilities: z.array(z.string()),
});
export const pingResultSchema = z.strictObject({
  ts: z.iso
    .datetime()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
});
export const shutdownResultSchema = z.strictObject({ ok: z.literal(true) });
export const helloResponseSchema = z.strictObject({
  ...envelope,
  result: helloResultSchema,
});
export const pingResponseSchema = z.strictObject({
  ...envelope,
  result: pingResultSchema,
});
export const shutdownResponseSchema = z.strictObject({
  ...envelope,
  result: shutdownResultSchema,
});

export const rpcErrorSchema = z.strictObject({
  code: z.union([
    z.literal(-32700),
    z.literal(-32600),
    z.literal(-32601),
    z.literal(-32602),
    z.literal(-32603),
  ]),
  message: z.string(),
});
export const errorResponseSchema = z.strictObject({
  ...envelope,
  error: rpcErrorSchema,
});
export const methodNotFoundResponseSchema = errorResponseSchema.extend({
  error: rpcErrorSchema.extend({ code: z.literal(-32601) }),
});
export const parseErrorResponseSchema = errorResponseSchema.extend({
  id: z.null(),
  error: rpcErrorSchema.extend({ code: z.literal(-32700) }),
});

export type HelloRequest = z.infer<typeof helloRequestSchema>;
export type HelloResponse = z.infer<typeof helloResponseSchema>;
export type PingRequest = z.infer<typeof pingRequestSchema>;
export type PingResponse = z.infer<typeof pingResponseSchema>;
export type ShutdownRequest = z.infer<typeof shutdownRequestSchema>;
export type ShutdownResponse = z.infer<typeof shutdownResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const fileScanStatusSchema = z.enum(['SCANNED', 'ERROR', 'SKIPPED']);
export const fileErrorCodeSchema = z.enum([
  'FILE_NOT_FOUND',
  'ACCESS_DENIED',
  'FILE_LOCKED',
  'IO_ERROR',
  'TOO_LARGE',
  'CLOUD_PLACEHOLDER',
  'TIMEOUT',
  'ENGINE_CRASHED',
]);

export const scanFileParamsSchema = z.strictObject({
  jobId: z.string(),
  taskId: z.string(),
  path: z.string(),
  options: z.strictObject({ maxBytes: z.number() }),
});

export const evidenceSourceSchema = z.enum([
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
  'ENGINE',
]);
export const layerSchema = z.enum([
  'HASH',
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
]);
export const evidenceSchema = z.strictObject({
  // Fin absoluto: impide aceptar un salto de línea después del identificador.
  id: z.string().regex(/^ev[1-9][0-9]*(?![\s\S])/),
  source: evidenceSourceSchema,
  code: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  points: z.number().int().nonnegative(),
  decisive: z.boolean(),
  confidence: z.number().min(0).max(1),
  // Diccionario de hechos: claves únicas; acceso promedio O(1), validación O(n).
  facts: z.record(z.string(), z.json()),
});
export const layerTraceSchema = z
  .strictObject({
    layer: layerSchema,
    status: z.enum(['RAN', 'SKIPPED', 'DISABLED', 'ERROR']),
    reason: z.string().regex(/\S/).optional(),
    hits: z.number().int().nonnegative(),
    points: z.number().int().nonnegative(),
    ms: z.number().nonnegative(),
  })
  .superRefine((trace, context) => {
    if (trace.status === 'SKIPPED' && trace.reason === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'SKIPPED requiere reason',
      });
    }
    if (trace.layer === 'HASH' && trace.status === 'DISABLED') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'HASH no se puede desactivar',
      });
    }
  });
export type Evidence = z.infer<typeof evidenceSchema>;
export type LayerTrace = z.infer<typeof layerTraceSchema>;

// File, hashes and error retain their S1 optionality; evidence and layers are required.
export const engineResultSchema = z
  .strictObject({
    taskId: z.string(),
    status: fileScanStatusSchema,
    file: z
      .strictObject({
        name: z.string(),
        extension: z.string().nullable(),
        sizeBytes: z.number(),
        modifiedAt: z.string(),
      })
      .optional(),
    hashes: z
      .strictObject({
        sha256: z
          .string()
          .length(64)
          .regex(/^[a-fA-F0-9]{64}$/),
      })
      .optional(),
    evidence: z.array(evidenceSchema),
    layers: z.array(layerTraceSchema).superRefine((layers, context) => {
      // Invariante: el Set contiene solo capas ya vistas, sin repetidas.
      // has/add cuestan O(1) promedio; recorrer n capas cuesta O(n) tiempo y espacio.
      const seen = new Set<string>();
      layers.forEach((trace, index) => {
        if (seen.has(trace.layer)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'layer'],
            message: 'Capa repetida',
          });
        }
        seen.add(trace.layer);
      });
    }),
    error: z
      .strictObject({ code: fileErrorCodeSchema, message: z.string() })
      .optional(),
    durationMs: z.number(),
    engineVersion: z.string(),
    verdict: z
      .enum(['CLEAN', 'SUSPICIOUS', 'DETECTED', 'ERROR', 'NOT_ANALYZED'])
      .optional(),
    score: z.number().int().min(0).max(100).nullable().optional(),
    riskLevel: z
      .enum(['BAJO', 'MEDIO', 'ALTO', 'CRÍTICO'])
      .nullable()
      .optional(),
  })
  .superRefine((result, context) => {
    const values = [result.verdict, result.score, result.riskLevel];
    if (values.every((value) => value === undefined)) return;
    const reject = (message: string) =>
      context.addIssue({ code: 'custom', message });
    if (values.some((value) => value === undefined)) {
      reject('La evaluación debe incluir verdict, score y riskLevel');
      return;
    }
    if (result.verdict === 'ERROR' || result.verdict === 'NOT_ANALYZED') {
      if (result.score !== null || result.riskLevel !== null)
        reject('Sin análisis no hay puntuación ni nivel');
      return;
    }
    if (result.score == null || result.riskLevel == null) {
      reject('Un veredicto de riesgo requiere puntuación y nivel');
      return;
    }
    const expected =
      result.score < 30
        ? 'BAJO'
        : result.score < 60
          ? 'MEDIO'
          : result.score < 85
            ? 'ALTO'
            : 'CRÍTICO';
    if (result.riskLevel !== expected)
      reject('Nivel incompatible con puntuación');
    if (
      (result.verdict === 'CLEAN' && result.score >= 30) ||
      (result.verdict === 'SUSPICIOUS' && result.score < 30) ||
      (result.verdict === 'DETECTED' && result.score < 85)
    )
      reject('Veredicto incompatible con puntuación');
  });

export const scanFileRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('scan.file'),
  params: scanFileParamsSchema,
});
export const scanFileResponseSchema = z.strictObject({
  ...envelope,
  result: engineResultSchema,
});

export type ScanFileParams = z.infer<typeof scanFileParamsSchema>;
export type EngineResult = z.infer<typeof engineResultSchema>;
export type ScanFileRequest = z.infer<typeof scanFileRequestSchema>;
export type ScanFileResponse = z.infer<typeof scanFileResponseSchema>;

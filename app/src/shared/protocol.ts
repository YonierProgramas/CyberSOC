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
  rulesetVersion: z.string().min(1),
});
export const statsResponseSchema = z.strictObject({
  ...envelope,
  result: statsResultSchema,
});
export type StatsRequest = z.infer<typeof statsRequestSchema>;
export type StatsResult = z.infer<typeof statsResultSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;

export const rulesReloadRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('rules.reload'),
  params: emptyParamsSchema,
});
export const rulesReloadResultSchema = z.strictObject({
  rulesetVersion: z.string().min(1),
  rulesCount: z.number().int().nonnegative(),
});
export const rulesReloadResponseSchema = z.strictObject({
  ...envelope,
  result: rulesReloadResultSchema,
});
export type RulesReloadRequest = z.infer<typeof rulesReloadRequestSchema>;
export type RulesReloadResult = z.infer<typeof rulesReloadResultSchema>;
export type RulesReloadResponse = z.infer<typeof rulesReloadResponseSchema>;

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
export const zoneSchema = z.enum([
  'DESCARGAS',
  'ESCRITORIO',
  'DOCUMENTOS',
  'TEMPORALES',
  'DATOS_APPS',
  'EXTRAIBLE',
  'PROGRAMAS',
  'SISTEMA',
  'OTRA',
]);
export const scanFileParamsSchema = z.strictObject({
  jobId: z.string(),
  taskId: z.string(),
  path: z.string(),
  options: z.strictObject({
    maxBytes: z.number(),
    zone: zoneSchema.optional(),
    layers: z
      .array(layerSchema)
      .refine((layers) => {
        // El Set contiene capas únicas; construcción O(n), pertenencia O(1) promedio.
        return new Set(layers).size === layers.length;
      }, 'Capa repetida')
      .optional(),
  }),
});
export const driveInfoParamsSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((path) => !path.includes('\u0000')),
});
export const driveInfoRequestSchema = z.strictObject({
  ...envelope,
  method: z.literal('fs.driveInfo'),
  params: driveInfoParamsSchema,
});
export const driveInfoResultSchema = z.strictObject({
  driveType: z.enum(['FIXED', 'REMOVABLE', 'NETWORK', 'CDROM', 'UNKNOWN']),
});
export const driveInfoResponseSchema = z.strictObject({
  ...envelope,
  result: driveInfoResultSchema,
});
export type Zone = z.infer<typeof zoneSchema>;
export type DriveInfoRequest = z.infer<typeof driveInfoRequestSchema>;
export type DriveInfoResult = z.infer<typeof driveInfoResultSchema>;
export type DriveInfoResponse = z.infer<typeof driveInfoResponseSchema>;
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
    if (
      ['SKIPPED', 'DISABLED'].includes(trace.status) &&
      trace.reason === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'SKIPPED/DISABLED requiere reason',
      });
    }
    if (
      ['HASH', 'SIGNATURES'].includes(trace.layer) &&
      trace.status === 'DISABLED'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'HASH y SIGNATURES no se pueden desactivar',
      });
    }
    if (
      trace.status === 'DISABLED' &&
      (trace.hits !== 0 || trace.points !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'DISABLED no ejecuta análisis',
      });
    }
  });
export type Evidence = z.infer<typeof evidenceSchema>;
export type LayerTrace = z.infer<typeof layerTraceSchema>;

// File, hashes and error retain their S1 optionality; evidence and layers are required.
const scoreGroupSchema = z.strictObject({
  raw: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  capped: z.number().int().min(0).max(100),
  cap: z.union([z.literal(50), z.literal(60), z.literal(100)]),
});
export const scoreBreakdownSchema = z
  .strictObject({
    version: z.literal('2'),
    heuristics: scoreGroupSchema,
    rules: scoreGroupSchema,
    signatures: scoreGroupSchema,
    rawTotal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cappedTotal: z.number().int().min(0).max(100),
    decisiveFloor: z.union([z.literal(0), z.literal(85)]),
    total: z.number().int().min(0).max(100),
  })
  .superRefine((value, context) => {
    const groups = [value.heuristics, value.rules, value.signatures];
    const caps = [50, 60, 100];
    const valid =
      groups.every(
        (g, i) => g.cap === caps[i] && g.capped === Math.min(g.raw, g.cap),
      ) &&
      value.rawTotal === groups.reduce((sum, g) => sum + g.raw, 0) &&
      value.cappedTotal ===
        Math.min(
          100,
          groups.reduce((sum, g) => sum + g.capped, 0),
        ) &&
      value.total === Math.max(value.cappedTotal, value.decisiveFloor);
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'Desglose de puntuación inconsistente',
      });
  });

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
    scoreBreakdown: scoreBreakdownSchema.nullable().optional(),
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
    if (
      result.scoreBreakdown &&
      (result.score !== result.scoreBreakdown.total ||
        !result.verdict ||
        (result.verdict === 'DETECTED') !==
          (result.scoreBreakdown.decisiveFloor === 85))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Desglose incompatible con evaluación',
      });
    }
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

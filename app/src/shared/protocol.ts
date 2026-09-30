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

import { z } from 'zod';

export const systemArgumentsSchema = z.tuple([]);
export const systemStatusSchema = z.strictObject({
  app: z.literal('CyberSOC Defender'),
  version: z.string(),
  engine: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('connected'),
      engineVersion: z.string(),
      protocol: z.literal('1'),
    }),
    z.strictObject({
      status: z.literal('disconnected'),
      engineVersion: z.null(),
      protocol: z.null(),
    }),
    z.strictObject({
      status: z.literal('incompatible'),
      engineVersion: z.string().nullable(),
      protocol: z.string().nullable(),
    }),
  ]),
});

import { z } from 'zod';
import { layerSchema } from './protocol';

export const scanProfileSchema = z.strictObject({
  layers: z
    .array(layerSchema)
    .min(2)
    .max(7)
    .refine(
      (layers) =>
        new Set(layers).size === layers.length &&
        layers.includes('HASH') &&
        layers.includes('SIGNATURES'),
      'Las capas deben ser únicas e incluir HASH y SIGNATURES.',
    ),
  includeHidden: z.boolean(),
  maxFileSizeMB: z
    .int()
    .min(1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 1_048_576)),
});

export const scanProfileChoiceSchema = z.union([
  z.literal('AUTO'),
  scanProfileSchema,
]);
export type ScanProfile = z.infer<typeof scanProfileSchema>;
export type ScanProfileChoice = z.infer<typeof scanProfileChoiceSchema>;

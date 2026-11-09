import { z } from 'zod';
import { layerSchema, zoneSchema } from './protocol';
import { scanProfileSchema } from './scan-profile';
import { ASSISTANT_CARD_SCHEMA_V1 } from './ipc';

const shortId = z.string().min(1).max(128);
// Same subschemas of the live response; no earlier bound changes.
export const assistantReferenceSchema = z.strictObject({
  type: z.enum(['result', 'job', 'rule', 'zone']),
  id: shortId,
});
export const assistantActionSchema = z.strictObject({
  action: z.enum([
    'OPEN_RESULT',
    'QUARANTINE',
    'ANALYZE_WITH_AI',
    'OPEN_QUARANTINE',
    'EXPORT_REPORT',
    'RUN_SCAN_PLAN',
  ]),
  targetId: shortId.nullable(),
});
export const reportCardSchema = z.strictObject({
  reportDraftId: z.string().uuid(),
  total: z.number().int().nonnegative(),
  verdicts: z
    .array(
      z.strictObject({
        verdict: z.string().max(32),
        count: z.number().int().nonnegative(),
      }),
    )
    .max(10),
  executiveSummary: z.string().max(8_000),
  conclusions: z.array(z.string().max(2_000)).max(20),
  citedResultIds: z.array(shortId).max(100),
  label: z.literal('Generado por IA'),
});
export const scanPlanCardSchema = z.strictObject({
  schema: z.literal('cybersoc.scan-plan/v1'),
  targets: z
    .array(
      z.strictObject({
        zoneId: zoneSchema,
        driveId: z.string().max(8).nullable(),
        paths: z.array(z.string().max(1_024)).max(20),
      }),
    )
    .min(1)
    .max(10),
  profile: scanProfileSchema,
  rationale: z.string().max(1_000),
  layerRationale: z
    .array(z.strictObject({ layer: layerSchema, why: z.string().max(400) }))
    .max(7),
});
export const assistantCardV1Schema = z.strictObject({
  schema: z.literal(ASSISTANT_CARD_SCHEMA_V1),
  focus: z.strictObject({
    kind: z.enum(['NONE', 'RESULT', 'JOB']),
    id: z.string().max(128).nullable(),
    label: z.string().max(32_767).nullable(),
  }),
  references: z.array(assistantReferenceSchema).max(20),
  suggestedActions: z.array(assistantActionSchema).max(6),
  report: reportCardSchema.nullable(),
  scanPlan: scanPlanCardSchema.nullable(),
});

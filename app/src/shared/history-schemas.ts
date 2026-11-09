import { z } from 'zod';
import type { DashboardOverviewDTO, ConversationMessagesPageDTO } from './ipc';
import { zoneSchema } from './protocol';
import {
  assistantActionSchema,
  assistantCardV1Schema,
} from './assistant-card-schemas';

export const jobStatusSchema = z.enum([
  'CREATED',
  'DISCOVERING',
  'SCANNING',
  'CANCELLING',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
]);
export const verdictSchema = z.enum([
  'NOT_EVALUATED',
  'CLEAN',
  'SUSPICIOUS',
  'DETECTED',
  'NOT_ANALYZED',
]);
export const resultStatusSchema = z.enum(['SCANNED', 'ERROR', 'SKIPPED']);
export const aiStatusSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'RUNNING',
  'RETRY_WAIT',
  'COMPLETED',
  'UNAVAILABLE',
  'INVALID',
  'NOT_CONFIGURED',
]);
export const quarantineStatusSchema = z.enum([
  'PENDING',
  'QUARANTINED',
  'RESTORED',
  'DELETED',
  'FAILED',
]);
const count = z.number().int().nonnegative();
const instant = z.iso.datetime();
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [
      number,
      number,
      number,
    ];
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return (
      year > 0 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  });
export const dashboardQuerySchema = z.strictObject({
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});
export const scanJobsPageQuerySchema = z
  .strictObject({
    offset: count,
    limit: count.min(1).max(200),
    statuses: z
      .array(jobStatusSchema)
      .max(7)
      .refine((values) => {
        // Set: one entry per status. O(n) build, O(n) memory; n ≤ 7.
        return new Set(values).size === values.length;
      })
      .optional(),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to);
export const conversationPageQuerySchema = z.strictObject({
  offset: count,
  limit: count.min(1).max(100),
});
export const messagesQuerySchema = z.strictObject({
  conversationId: z.string().uuid(),
  before: z.string().uuid().optional(),
  limit: count.min(1).max(100).optional(),
});
export const scanJobSchema = z.strictObject({
  id: z.string().min(1),
  targetPath: z.string(),
  targetKind: z.enum(['FILE', 'FOLDER']),
  status: jobStatusSchema,
  filesDiscovered: count,
  filesProcessed: count,
  filesError: count,
  filesSkipped: count,
  bytesProcessed: count,
  engineVersion: z.string().nullable(),
  protocolVersion: z.string().nullable(),
  rulesetVersion: z.string().nullable(),
  signaturesVersion: z.string().nullable(),
  profileJson: z.string().nullable(),
  metricsJson: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: instant,
  startedAt: instant.nullable(),
  finishedAt: instant.nullable(),
});
const rangeSchema = z.strictObject({
  from: localDateSchema,
  to: localDateSchema,
});
const distributionSchema = z.strictObject({
  scope: z.enum(['LAST_COMPLETED', 'ALL_COMPLETED', 'RANGE']),
  jobStatuses: z.array(jobStatusSchema).max(7),
  range: rangeSchema.nullable(),
  jobs: count,
  results: z.strictObject({
    total: count,
    byVerdict: z.record(verdictSchema, count),
    byStatus: z.record(resultStatusSchema, count),
    byZone: z
      .array(z.strictObject({ zone: zoneSchema.nullable(), results: count }))
      .max(10),
    byAiStatus: z.record(aiStatusSchema, count),
  }),
  excluded: z.strictObject({
    jobs: count,
    results: count,
    byJobStatus: z.record(jobStatusSchema, count),
  }),
  partial: z.boolean(),
});
export const dashboardOverviewSchema: z.ZodType<DashboardOverviewDTO> =
  z.strictObject({
    schema: z.literal('cybersoc.dashboard/v1'),
    generatedAt: instant,
    timezone: z.string().min(1),
    range: rangeSchema.extend({ days: count.min(1).max(366) }),
    activity: z.strictObject({
      jobs: z.strictObject({
        total: count,
        byStatus: z.record(jobStatusSchema, count),
      }),
      daily: z
        .array(
          z.strictObject({
            date: localDateSchema,
            jobs: count,
            results: count,
            detected: count,
            suspicious: count,
            errors: count,
          }),
        )
        .min(1)
        .max(366),
    }),
    distributions: z.strictObject({
      lastCompleted: distributionSchema
        .extend({ scope: z.literal('LAST_COMPLETED'), job: scanJobSchema })
        .nullable(),
      allCompleted: distributionSchema.extend({
        scope: z.literal('ALL_COMPLETED'),
      }),
      range: distributionSchema.extend({ scope: z.literal('RANGE') }),
    }),
    active: scanJobSchema.nullable(),
    quarantine: z.record(quarantineStatusSchema, count),
    allTime: z.strictObject({
      jobs: count,
      results: count,
      firstJobAt: instant.nullable(),
      byJobStatus: z.record(jobStatusSchema, count),
    }),
  });
export const jobsPageSchema = z.strictObject({
  items: z.array(scanJobSchema).max(200),
  offset: count,
  limit: count.min(1).max(200),
  total: count,
});
export const conversationsPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        title: z.string().nullable(),
        createdAt: instant,
        updatedAt: instant,
        messageCount: count,
        lastMessageAt: instant.nullable(),
      }),
    )
    .max(100),
  offset: count,
  limit: count.min(1).max(100),
  total: count,
});
const actionStateSchema = z.strictObject({
  index: count,
  action: assistantActionSchema.shape.action,
  targetId: assistantActionSchema.shape.targetId,
  availability: z.enum([
    'AVAILABLE',
    'MISSING',
    'NOT_APPLICABLE',
    'EXPIRED',
    'HISTORY_READ_ONLY',
  ]),
});
const historyItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('USER'),
    id: z.string().uuid(),
    createdAt: instant,
    text: z.string(),
    answered: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('ASSISTANT'),
    id: z.string().uuid(),
    createdAt: instant,
    text: z.string(),
    model: z.string().nullable(),
    cardState: z.enum(['RECORDED', 'NOT_RECORDED', 'OMITTED']),
    card: assistantCardV1Schema.nullable(),
    actionStates: z.array(actionStateSchema).max(6),
  }),
  z.strictObject({
    kind: z.literal('TOOLS'),
    id: z.string().uuid(),
    createdAt: instant,
    tools: z
      .array(
        z.strictObject({
          name: z.string().max(64),
          ok: z.boolean(),
          code: z.string().max(32).nullable(),
        }),
      )
      .max(60),
  }),
]);
export const messagesPageSchema: z.ZodType<ConversationMessagesPageDTO> = z
  .strictObject({
    conversationId: z.string().uuid(),
    items: z.array(historyItemSchema).max(100),
    olderCursor: z.string().uuid().nullable(),
    total: count,
  })
  .refine((page) =>
    page.items.every(
      (item) =>
        item.kind !== 'ASSISTANT' ||
        (item.cardState === 'RECORDED'
          ? item.card !== null &&
            item.actionStates.length === item.card.suggestedActions.length &&
            item.actionStates.every(
              (state, index) =>
                state.index === index &&
                state.action === item.card!.suggestedActions[index]!.action &&
                state.targetId === item.card!.suggestedActions[index]!.targetId,
            )
          : item.card === null && item.actionStates.length === 0),
    ),
  );

import { z } from 'zod';
import { hasUnsupportedActionClaim } from './AssistantActionClaims';
import { zoneSchema } from '../../shared/protocol';
import {
  scanPlanDraftSchema,
  validateScanPlan,
  type ValidScanPlan,
  type ZoneOption,
} from './ScanPlanValidator';

export const REFERENCE_TYPES = ['result', 'job', 'rule', 'zone'] as const;
export const SUGGESTED_ACTIONS = [
  'OPEN_RESULT',
  'QUARANTINE',
  'ANALYZE_WITH_AI',
  'OPEN_QUARANTINE',
  'EXPORT_REPORT',
  'RUN_SCAN_PLAN',
] as const;

export const ASSISTANT_REPLY_LIMITS = {
  answer: 6_000,
  maxReferences: 20,
  maxActions: 6,
  executiveSummary: 4_000,
  maxConclusions: 10,
  conclusion: 600,
  maxCited: 50,
} as const;
const A = ASSISTANT_REPLY_LIMITS;

/**
 * Copilot v2 final response as it travels in `output_config.format`.
 * No unions or optional fields: the API allows at most 16 union parameters per
 * request and the 14 tools already use 16. That is why `report` and `scanPlan` are lists of
 * 0 or 1 elements and `targetId` uses "" when the action has no target.
 * It has no count or length caps either: strict mode does not support them (the grammar
 * would not enforce them) and a long list must not reject a valid response. The Core
 * trims to ASSISTANT_REPLY_LIMITS in validateAssistantReply.
 */
export const assistantReplyWireSchema = z.strictObject({
  answer: z.string().min(1).describe('Respuesta en texto plano, en español.'),
  references: z
    .array(
      z.strictObject({
        type: z.enum(REFERENCE_TYPES),
        id: z.string().min(1).max(128),
      }),
    )
    .describe(
      `IDs reales de resultados, escaneos, reglas o zonas que usaste (máximo ${A.maxReferences}).`,
    ),
  suggestedActions: z
    .array(
      z.strictObject({
        action: z.enum(SUGGESTED_ACTIONS),
        targetId: z
          .string()
          .max(128)
          .describe(
            'resultId, reportDraftId o "" si la acción no tiene destino.',
          ),
      }),
    )
    .describe(
      `Acciones que el usuario puede confirmar con un botón (máximo ${A.maxActions}). Nunca las ejecutas tú.`,
    ),
  report: z
    .array(
      z.strictObject({
        reportDraftId: z.string().min(1).max(128),
        executiveSummary: z.string().min(1),
        conclusions: z.array(z.string().min(1)),
        citedResultIds: z.array(z.string().min(1).max(128)),
      }),
    )
    .describe('Vacío, o un elemento si llamaste a build_report.'),
  scanPlan: z
    .array(scanPlanDraftSchema)
    .describe('Vacío, o un elemento con el plan propuesto (scan-plan/v1).'),
});
export type AssistantReplyWire = z.infer<typeof assistantReplyWireSchema>;

export interface AssistantReference {
  type: (typeof REFERENCE_TYPES)[number];
  id: string;
}
export interface AssistantAction {
  action: (typeof SUGGESTED_ACTIONS)[number];
  targetId: string | null;
}
export interface AssistantReport {
  reportDraftId: string;
  executiveSummary: string;
  conclusions: string[];
  citedResultIds: string[];
}

/** Validated final response, in the S5 plan shape (`report?` and `scanPlan?`). */
export interface AssistantFinal {
  answer: string;
  references: AssistantReference[];
  suggestedActions: AssistantAction[];
  report?: AssistantReport;
  scanPlan?: ValidScanPlan;
}

/** Read-only queries the Core uses to check that everything cited exists. */
export interface ReplyChecks {
  /** Result verdict, or null if it does not exist. */
  resultVerdict(id: string): string | null;
  jobExists(id: string): boolean;
  ruleExists(id: string): Promise<boolean>;
  /** Result IDs of the draft, or null if it does not exist or has expired. */
  reportResultIds(reportDraftId: string): string[] | null;
  /** Real list_zones rows (run by the Core, not copied from the AI). */
  zones(): Promise<ZoneOption[]>;
}

export type ReplyValidation =
  { ok: true; final: AssistantFinal } | { ok: false; errors: string[] };

/**
 * Validates the final response: every `id`, `targetId`, `reportDraftId` and `citedResultIds`
 * must exist, actions must belong to the enum (guaranteed by the schema) and the plan must
 * pass `validateScanPlan`. Error messages are written by the Core, never the AI.
 */
export async function validateAssistantReply(
  wire: AssistantReplyWire,
  checks: ReplyChecks,
): Promise<ReplyValidation> {
  const errors: string[] = [];
  const narrative = [
    wire.answer,
    ...wire.report.flatMap((report) => [
      report.executiveSummary,
      ...report.conclusions,
    ]),
    ...wire.scanPlan.flatMap((plan) => [
      plan.rationale,
      ...plan.layerRationale.map((entry) => entry.why),
    ]),
  ];
  if (narrative.some(hasUnsupportedActionClaim))
    errors.push(
      'El Copilot no puede afirmar que ejecutó cambios, borrados, cuarentena o escaneos. Solo consulta y propone acciones para confirmar en la interfaz.',
    );
  // Caps are applied by trimming: excess text or elements do not invalidate the response.
  const answer = clip(wire.answer.trim(), A.answer);
  if (answer === '') errors.push('La respuesta está vacía.');

  const references: AssistantReference[] = [];
  const seenRefs = new Set<string>();
  for (const ref of wire.references) {
    const key = `${ref.type}:${ref.id}`;
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    const exists =
      ref.type === 'result'
        ? checks.resultVerdict(ref.id) !== null
        : ref.type === 'job'
          ? checks.jobExists(ref.id)
          : ref.type === 'rule'
            ? await checks.ruleExists(ref.id)
            : zoneSchema.safeParse(ref.id).success;
    if (!exists)
      errors.push(`Referencia inexistente: ${ref.type} ${quote(ref.id)}.`);
    else if (references.length < A.maxReferences)
      references.push({ type: ref.type, id: ref.id });
  }

  let report: AssistantReport | undefined;
  const [draft] = wire.report;
  if (draft) {
    const ids = checks.reportResultIds(draft.reportDraftId);
    if (ids === null)
      errors.push(
        `Borrador de reporte inexistente: ${quote(draft.reportDraftId)}.`,
      );
    else {
      const foreign = draft.citedResultIds.filter((id) => !ids.includes(id));
      for (const id of foreign)
        errors.push(
          `El reporte cita un resultado que no está en el borrador: ${quote(id)}.`,
        );
      if (foreign.length === 0)
        report = {
          reportDraftId: draft.reportDraftId,
          executiveSummary: clip(
            draft.executiveSummary.trim(),
            A.executiveSummary,
          ),
          conclusions: draft.conclusions
            .slice(0, A.maxConclusions)
            .map((item) => clip(item.trim(), A.conclusion)),
          citedResultIds: [...new Set(draft.citedResultIds)].slice(
            0,
            A.maxCited,
          ),
        };
    }
  }

  let scanPlan: ValidScanPlan | undefined;
  const [plan] = wire.scanPlan;
  if (plan) {
    const checked = validateScanPlan(plan, await checks.zones());
    if (checked.ok) scanPlan = checked.plan;
    else
      errors.push(...checked.errors.map((error) => `Plan rechazado: ${error}`));
  }

  const suggestedActions: AssistantAction[] = [];
  const seenActions = new Set<string>();
  for (const item of wire.suggestedActions) {
    const targetId = item.targetId.trim();
    const key = `${item.action}:${targetId}`;
    if (seenActions.has(key)) continue;
    seenActions.add(key);
    const problem = actionProblem(item.action, targetId, checks, report, plan);
    if (problem) errors.push(problem);
    else if (suggestedActions.length < A.maxActions)
      suggestedActions.push({
        action: item.action,
        targetId: targetId || null,
      });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    final: {
      answer,
      references,
      suggestedActions,
      ...(report ? { report } : {}),
      ...(scanPlan ? { scanPlan } : {}),
    },
  };
}

function actionProblem(
  action: AssistantAction['action'],
  targetId: string,
  checks: ReplyChecks,
  report: AssistantReport | undefined,
  plan: unknown,
): string | null {
  switch (action) {
    case 'OPEN_RESULT':
    case 'ANALYZE_WITH_AI':
      return checks.resultVerdict(targetId) === null
        ? `${action} apunta a un resultado inexistente: ${quote(targetId)}.`
        : null;
    case 'QUARANTINE': {
      const verdict = checks.resultVerdict(targetId);
      if (verdict === null)
        return `QUARANTINE apunta a un resultado inexistente: ${quote(targetId)}.`;
      return verdict === 'DETECTED' || verdict === 'SUSPICIOUS'
        ? null
        : `QUARANTINE solo aplica a resultados DETECTED o SUSPICIOUS (${quote(targetId)} es ${verdict}).`;
    }
    case 'OPEN_QUARANTINE':
      return targetId === '' ? null : 'OPEN_QUARANTINE no lleva destino.';
    case 'EXPORT_REPORT':
      return report && report.reportDraftId === targetId
        ? null
        : `EXPORT_REPORT debe apuntar al reporte de esta respuesta: ${quote(targetId)}.`;
    case 'RUN_SCAN_PLAN':
      return plan && targetId === ''
        ? null
        : 'RUN_SCAN_PLAN requiere un plan en esta respuesta y no lleva destino.';
  }
}

/** Trims long AI text without rejecting the response. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** AI text quoted in a Core message: bounded and in quotation marks. */
function quote(value: string): string {
  const short = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return JSON.stringify(short);
}

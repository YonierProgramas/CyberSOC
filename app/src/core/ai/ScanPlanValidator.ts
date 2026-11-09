import { z } from 'zod';
import { layerSchema, zoneSchema } from '../../shared/protocol';
import { scanProfileSchema, type ScanProfile } from '../../shared/scan-profile';

export const SCAN_PLAN_SCHEMA_ID = 'cybersoc.scan-plan/v1';

/** Allowed ranges for a plan proposed by the AI. */
export const SCAN_PLAN_LIMITS = {
  maxTargets: 10,
  minFileSizeMB: 1,
  maxFileSizeMB: 4_096,
  rationale: 1_000,
  layerWhy: 400,
} as const;
const L = SCAN_PLAN_LIMITS;

const MANDATORY_LAYERS = ['HASH', 'SIGNATURES'] as const;

/**
 * Plan as written by the AI (D16). It has no path field: targets are
 * zones or drives, and the Core fills in the real paths from `list_zones`.
 * `zoneId` and `layers` are free text on purpose: this validator, not the schema,
 * decides which values exist, so each rejection can be explained.
 */
export const scanPlanDraftSchema = z.strictObject({
  schema: z.literal(SCAN_PLAN_SCHEMA_ID),
  targets: z
    .array(
      z.strictObject({
        zoneId: z.string().max(32),
        driveId: z
          .string()
          .max(8)
          .describe(
            'Unidad de list_zones (p. ej. "E:") o "" si la zona no es extraíble.',
          ),
      }),
    )
    .describe('Zonas o unidades devueltas por list_zones. Nunca rutas.'),
  layers: z
    .array(z.string().max(32))
    .describe(
      'Capas: HASH, SIGNATURES, FILETYPE, RULES, HEURISTICS, PE, SCRIPTS.',
    ),
  includeHidden: z.boolean(),
  maxFileSizeMB: z
    .number()
    .int()
    .describe(`Entre ${L.minFileSizeMB} y ${L.maxFileSizeMB}.`),
  rationale: z.string().max(L.rationale),
  layerRationale: z.array(
    z.strictObject({
      layer: z.string().max(32),
      why: z.string().max(L.layerWhy),
    }),
  ),
});
export type ScanPlanDraft = z.infer<typeof scanPlanDraftSchema>;

/** A `list_zones` row: the only thing that can be a plan target. */
export interface ZoneOption {
  zoneId: string;
  driveId?: string;
  paths: readonly string[];
}

export interface ResolvedTarget {
  zoneId: z.infer<typeof zoneSchema>;
  driveId: string | null;
  /** Real paths of the zone according to `list_zones` (filled in by the Core, never the AI). */
  paths: string[];
}

export interface ValidScanPlan {
  schema: typeof SCAN_PLAN_SCHEMA_ID;
  targets: ResolvedTarget[];
  /** Profile ready for `scan.start` (CUSTOM profile). Only used if the user confirms it. */
  profile: ScanProfile;
  rationale: string;
  layerRationale: { layer: ScanProfile['layers'][number]; why: string }[];
}

export type ScanPlanValidation =
  { ok: true; plan: ValidScanPlan } | { ok: false; errors: string[] };

/**
 * Validates a `scan-plan/v1` proposed by the AI. A valid plan is returned to the UI as a
 * card: this module does not know the scan orchestrator and NEVER starts a scan.
 */
export function validateScanPlan(
  input: unknown,
  zones: readonly ZoneOption[],
): ScanPlanValidation {
  const parsed = scanPlanDraftSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, errors: ['El plan no cumple scan-plan/v1.'] };
  const draft = parsed.data;
  const errors: string[] = [];

  // Targets: each one must match a real list_zones row.
  if (draft.targets.length === 0) errors.push('El plan no tiene destinos.');
  if (draft.targets.length > L.maxTargets)
    errors.push(`El plan tiene más de ${L.maxTargets} destinos.`);
  const targets: ResolvedTarget[] = [];
  const seen = new Set<string>();
  for (const target of draft.targets) {
    const driveId = target.driveId.trim().toUpperCase();
    const zone = zoneSchema.safeParse(target.zoneId);
    const match = zones.find(
      (option) =>
        option.zoneId === target.zoneId &&
        (option.driveId ?? '').toUpperCase() === driveId &&
        option.paths.length > 0,
    );
    if (!zone.success || !match) {
      errors.push(
        `Destino no devuelto por list_zones: ${describeTarget(target.zoneId, driveId)}.`,
      );
      continue;
    }
    const key = `${zone.data}|${driveId}`;
    if (seen.has(key)) continue; // a repeated target is not scanned twice
    seen.add(key);
    targets.push({
      zoneId: zone.data,
      driveId: driveId || null,
      paths: [...match.paths],
    });
  }

  // Layers: from the enum, without repeats, with HASH and SIGNATURES always active.
  const layers: ScanProfile['layers'] = [];
  for (const name of draft.layers) {
    const layer = layerSchema.safeParse(name);
    if (!layer.success) errors.push(`Capa desconocida: ${quote(name)}.`);
    else if (layers.includes(layer.data))
      errors.push(`Capa repetida: ${layer.data}.`);
    else layers.push(layer.data);
  }
  for (const layer of MANDATORY_LAYERS)
    if (!layers.includes(layer))
      errors.push(`Falta la capa obligatoria ${layer}.`);

  // Size and texts within the ranges.
  if (
    draft.maxFileSizeMB < L.minFileSizeMB ||
    draft.maxFileSizeMB > L.maxFileSizeMB
  )
    errors.push(
      `maxFileSizeMB debe estar entre ${L.minFileSizeMB} y ${L.maxFileSizeMB}.`,
    );
  if (draft.rationale.trim() === '')
    errors.push('El plan no explica por qué (rationale).');
  const layerRationale: ValidScanPlan['layerRationale'] = [];
  for (const item of draft.layerRationale) {
    const layer = layerSchema.safeParse(item.layer);
    if (!layer.success || !layers.includes(layer.data))
      errors.push(
        `La justificación cita una capa que no está en el plan: ${quote(item.layer)}.`,
      );
    else if (item.why.trim() !== '')
      layerRationale.push({ layer: layer.data, why: item.why.trim() });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      schema: SCAN_PLAN_SCHEMA_ID,
      targets,
      profile: scanProfileSchema.parse({
        layers,
        includeHidden: draft.includeHidden,
        maxFileSizeMB: draft.maxFileSizeMB,
      }),
      rationale: draft.rationale.trim(),
      layerRationale,
    },
  };
}

/** `list_zones` rows from the bounded tool result. */
export function zoneOptionsFrom(data: unknown): ZoneOption[] {
  const rows = (data as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = z
      .object({
        zoneId: z.string(),
        driveId: z.string().optional(),
        paths: z.array(z.string()),
      })
      .safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

function describeTarget(zoneId: string, driveId: string): string {
  return driveId ? `${quote(zoneId)} ${quote(driveId)}` : quote(zoneId);
}

/** AI text quoted in a Core message: bounded and in quotation marks. */
function quote(value: string): string {
  const short = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return JSON.stringify(short);
}

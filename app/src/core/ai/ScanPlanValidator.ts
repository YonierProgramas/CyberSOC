import { z } from 'zod';
import { layerSchema, zoneSchema } from '../../shared/protocol';
import { scanProfileSchema, type ScanProfile } from '../../shared/scan-profile';

export const SCAN_PLAN_SCHEMA_ID = 'cybersoc.scan-plan/v1';

/** Rangos permitidos para un plan propuesto por la IA. */
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
 * Plan tal como lo escribe la IA (D16). No tiene ningún campo de ruta: los destinos son
 * zonas o unidades, y las rutas reales las pone el Core a partir de `list_zones`.
 * `zoneId` y `layers` son texto libre a propósito: este validador, no el esquema,
 * decide qué valores existen, para poder explicar cada rechazo.
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

/** Una fila de `list_zones`: lo único que puede ser destino de un plan. */
export interface ZoneOption {
  zoneId: string;
  driveId?: string;
  paths: readonly string[];
}

export interface ResolvedTarget {
  zoneId: z.infer<typeof zoneSchema>;
  driveId: string | null;
  /** Rutas reales de la zona según `list_zones` (las pone el Core, nunca la IA). */
  paths: string[];
}

export interface ValidScanPlan {
  schema: typeof SCAN_PLAN_SCHEMA_ID;
  targets: ResolvedTarget[];
  /** Perfil listo para `scan.start` (perfil CUSTOM). Solo se usa si el usuario lo confirma. */
  profile: ScanProfile;
  rationale: string;
  layerRationale: { layer: ScanProfile['layers'][number]; why: string }[];
}

export type ScanPlanValidation =
  { ok: true; plan: ValidScanPlan } | { ok: false; errors: string[] };

/**
 * Valida un `scan-plan/v1` propuesto por la IA. Un plan válido se devuelve a la UI como
 * tarjeta: este módulo no conoce el orquestador de escaneo y NUNCA inicia un escaneo.
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

  // Destinos: cada uno debe coincidir con una fila real de list_zones.
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
    if (seen.has(key)) continue; // un destino repetido no se escanea dos veces
    seen.add(key);
    targets.push({
      zoneId: zone.data,
      driveId: driveId || null,
      paths: [...match.paths],
    });
  }

  // Capas: del enum, sin repetir, con HASH y SIGNATURES siempre activas.
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

  // Tamaño y textos dentro de los rangos.
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

/** Filas de `list_zones` a partir del resultado acotado de la herramienta. */
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

/** Texto de la IA citado en un mensaje del Core: acotado y entre comillas. */
function quote(value: string): string {
  const short = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return JSON.stringify(short);
}

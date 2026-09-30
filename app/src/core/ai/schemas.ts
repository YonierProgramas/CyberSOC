import { z } from 'zod';
import { toClaudeJsonSchema } from './providers/ClaudeProvider';

export const AI_CONTEXT_SCHEMA_ID = 'cybersoc.ai-context/v1';
export const AI_ASSESSMENT_SCHEMA_ID = 'cybersoc.ai-assessment/v1';

/** Longitudes máximas (en unidades UTF-16, como `string.length`) y topes de `ai-context/v1`. */
export const AI_CONTEXT_LIMITS = {
  resultId: 64,
  fileName: 255,
  extension: 32,
  detectedType: 64,
  location: 260,
  version: 96,
  evidenceCode: 64,
  evidenceSummary: 300,
  maxEvidence: 20,
  maxLayers: 16,
  layerReason: 64,
  profileName: 40,
} as const;

/** Longitudes máximas de `ai-assessment/v1`. Caben en el `max_tokens` del análisis (≈ 1 200). */
export const AI_ASSESSMENT_LIMITS = {
  summary: 280,
  plainExplanation: 800,
  technicalAnalysis: 1200,
  maxCorrelations: 5,
  insight: 300,
  actionRationale: 400,
  falsePositiveNotes: 400,
  maxCitedEvidence: 20,
} as const;

// ---------------------------------------------------------------------------
// Enums compartidos
// ---------------------------------------------------------------------------

/** Capa que produjo una evidencia. En S2 solo existen SIGNATURES y FILETYPE. */
export const evidenceSourceSchema = z.enum([
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
  'ENGINE',
]);
export const severitySchema = z.enum([
  'INFO',
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);
/** Capas del motor para la traza (D18). */
export const engineLayerSchema = z.enum([
  'HASH',
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
]);
export const layerStatusSchema = z.enum([
  'RAN',
  'SKIPPED',
  'DISABLED',
  'ERROR',
]);
/** Mismos valores que `scan_results.verdict`. */
export const engineVerdictSchema = z.enum([
  'NOT_EVALUATED',
  'CLEAN',
  'SUSPICIOUS',
  'DETECTED',
  'NOT_ANALYZED',
]);
// Mismos valores que el contrato del motor (T2.1) y risk_assessments (T2.4).
export const riskLevelSchema = z.enum(['BAJO', 'MEDIO', 'ALTO', 'CRÍTICO']);
/** Zonas de D15 (S3). */
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
export const aiOpinionSchema = z.enum([
  'LIKELY_BENIGN',
  'SUSPICIOUS',
  'LIKELY_MALICIOUS',
  'INSUFFICIENT_EVIDENCE',
]);
export const recommendedActionSchema = z.enum([
  'NO_ACTION',
  'MONITOR',
  'VERIFY_SOURCE',
  'QUARANTINE',
  'RESTORE_IF_TRUSTED',
]);

/** `ev1..evN`, en el orden estable del motor. */
export const evidenceIdSchema = z.string().regex(/^ev[1-9][0-9]{0,2}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonNegativeInt = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// ai-context/v1: lo único que sale del equipo hacia la IA
// ---------------------------------------------------------------------------

const L = AI_CONTEXT_LIMITS;

const contextFileSchema = z.strictObject({
  resultId: z.string().min(1).max(L.resultId),
  /** Nombre real o seudónimo (ver `constraints.fileNamePseudonymized`). */
  name: z.string().min(1).max(L.fileName),
  extension: z.string().max(L.extension).nullable(),
  /** Tipo real por magic numbers (S2); `null` si aún no se calcula. */
  detectedType: z.string().max(L.detectedType).nullable(),
  typeMatchesExtension: z.boolean().nullable(),
  sizeBytes: nonNegativeInt.nullable(),
  /** Carpeta del archivo con la ruta de usuario anonimizada (`%USERPROFILE%\…`). */
  location: z.string().max(L.location),
  sha256: sha256Schema.nullable(),
  /** Llega en S3 (D15). */
  zone: zoneSchema.optional(),
});

const scoreItemSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  points: nonNegativeInt.max(100),
});

const contextEngineSchema = z.strictObject({
  engineVersion: z.string().max(L.version).nullable(),
  signaturesVersion: z.string().max(L.version).nullable(),
  verdict: engineVerdictSchema,
  /** `null` mientras el motor no puntúe (S1). */
  score: nonNegativeInt.max(100).nullable(),
  riskLevel: riskLevelSchema.nullable(),
  scoreBreakdown: z.array(scoreItemSchema).max(L.maxEvidence),
});

const contextEvidenceSchema = z.strictObject({
  id: evidenceIdSchema,
  source: evidenceSourceSchema,
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .max(L.evidenceCode),
  severity: severitySchema,
  summary: z.string().min(1).max(L.evidenceSummary),
});

/** Traza de capas (D18). Llega en S2. */
const contextLayerSchema = z.strictObject({
  layer: engineLayerSchema,
  status: layerStatusSchema,
  hits: nonNegativeInt,
  reason: z.string().min(1).max(L.layerReason).optional(),
});

/** Perfil de capas aplicado al archivo (D15). Llega en S3. */
const contextProfileSchema = z.strictObject({
  name: z.string().min(1).max(L.profileName),
  layers: z
    .array(engineLayerSchema)
    .min(1)
    .max(engineLayerSchema.options.length),
});

const contextHistorySchema = z.strictObject({
  timesSeenBefore: nonNegativeInt,
});

const contextConstraintsSchema = z.strictObject({
  evidenceTruncated: z.boolean(),
  /** Algún campo se recortó por superar su longitud máxima. */
  fieldsTruncated: z.boolean(),
  fileNamePseudonymized: z.boolean(),
  /** Nunca se envía contenido del archivo. */
  contentIncluded: z.literal(false),
});

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export const aiContextSchema = z
  .strictObject({
    schema: z.literal(AI_CONTEXT_SCHEMA_ID),
    task: z.literal('ANALYZE_FILE_RESULT'),
    locale: z.literal('es-CO'),
    file: contextFileSchema,
    engine: contextEngineSchema,
    evidence: z.array(contextEvidenceSchema).max(L.maxEvidence),
    layers: z.array(contextLayerSchema).max(L.maxLayers).optional(),
    profile: contextProfileSchema.optional(),
    /** Veces que se vio el mismo SHA-256 antes; lo calculará el Core desde SQLite. */
    history: contextHistorySchema.optional(),
    constraints: contextConstraintsSchema,
  })
  .superRefine((context, ctx) => {
    const ids = context.evidence.map((item) => item.id);
    if (hasDuplicates(ids)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'IDs de evidencia repetidos.',
      });
    }
    const known = new Set(ids);
    context.engine.scoreBreakdown.forEach((item, index) => {
      if (!known.has(item.evidenceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['engine', 'scoreBreakdown', index, 'evidenceId'],
          message: `La evidencia ${item.evidenceId} no está en el contexto.`,
        });
      }
    });
    if (context.layers && hasDuplicates(context.layers.map((l) => l.layer))) {
      ctx.addIssue({
        code: 'custom',
        path: ['layers'],
        message: 'Cada capa aparece una sola vez.',
      });
    }
    if (context.profile && hasDuplicates(context.profile.layers)) {
      ctx.addIssue({
        code: 'custom',
        path: ['profile', 'layers'],
        message: 'Capas repetidas en el perfil.',
      });
    }
  });

export type AIContext = z.infer<typeof aiContextSchema>;

// ---------------------------------------------------------------------------
// ai-assessment/v1: respuesta esperada de la IA
// ---------------------------------------------------------------------------

const A = AI_ASSESSMENT_LIMITS;

// Las salidas estructuradas no admiten maxLength ni rangos: los límites van también en la
// descripción para que el modelo los vea; zod los hace cumplir al validar.
const text = (max: number, description: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .describe(`${description} Máximo ${max} caracteres.`);

const correlationSchema = z.strictObject({
  evidenceIds: z
    .array(evidenceIdSchema)
    .min(1)
    .max(L.maxEvidence)
    .describe('IDs de evidencia del contexto que se relacionan (ev1, ev2…).'),
  insight: text(A.insight, 'Qué indica la combinación de esas evidencias.'),
});

export const aiAssessmentSchema = z.strictObject({
  schema: z.literal(AI_ASSESSMENT_SCHEMA_ID),
  summary: text(A.summary, 'Resumen en una o dos frases.'),
  plainExplanation: text(
    A.plainExplanation,
    'Explicación para un usuario sin conocimientos técnicos.',
  ),
  technicalAnalysis: text(
    A.technicalAnalysis,
    'Análisis técnico basado solo en las evidencias del contexto.',
  ),
  correlations: z
    .array(correlationSchema)
    .max(A.maxCorrelations)
    .describe(`Hasta ${A.maxCorrelations} correlaciones entre evidencias.`),
  opinion: aiOpinionSchema,
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confianza en la opinión, entre 0 y 1.'),
  recommendedAction: recommendedActionSchema,
  actionRationale: text(A.actionRationale, 'Por qué se recomienda esa acción.'),
  falsePositiveNotes: z
    .string()
    .max(A.falsePositiveNotes)
    .describe(
      `Motivos por los que podría ser un falso positivo; vacío si no hay. Máximo ${A.falsePositiveNotes} caracteres.`,
    ),
  citedEvidenceIds: z
    .array(evidenceIdSchema)
    .max(A.maxCitedEvidence)
    .describe(
      'IDs de las evidencias del contexto en las que se basa la opinión.',
    ),
});

export type AIAssessment = z.infer<typeof aiAssessmentSchema>;

/**
 * JSON Schema de `ai-assessment/v1` para `output_config.format` de la API de Claude.
 * Es exactamente el que envía `ClaudeProvider` al recibir `aiAssessmentSchema`.
 */
export function aiAssessmentJsonSchema(): Record<string, unknown> {
  return toClaudeJsonSchema(aiAssessmentSchema);
}

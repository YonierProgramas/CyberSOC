import { z } from 'zod';
import type { AppConfig } from '../config/AppConfig';
import type { Database } from '../persistence/Database';
import { AIAnalysisRepository } from '../persistence/AIAnalysisRepository';
import { RiskAssessmentRepository } from '../persistence/RiskAssessmentRepository';
import { ScanJobRepository } from '../persistence/ScanJobRepository';
import { AIAnalysisStore } from './AIAnalysisStore';
import { AIContextBuilder, toPromptSafeJson } from './AIContextBuilder';
import { buildJobSummaryContext } from './JobSummaryContext';
import { JobSummaryStore } from './JobSummaryStore';
import {
  aiAssessmentSchema,
  aiContextSchema,
  engineLayerSchema,
  jobSummaryContextSchema,
  jobSummarySchema,
  riskLevelSchema,
  zoneSchema,
  type AIContext,
} from './schemas';

export const ASSISTANT_FOCUS_SCHEMA_ID = 'cybersoc.assistant-focus/v1';

/** El último análisis VALID, sin el identificador de esquema (no aporta nada al chat). */
const lastAnalysisSchema = aiAssessmentSchema.omit({ schema: true });

/** Decisión de RiskPolicy guardada en `risk_assessments`: el veredicto que ve el usuario. */
const decisionSchema = z.strictObject({
  finalVerdict: z.enum(['CLEAN', 'SUSPICIOUS', 'DETECTED']),
  finalLevel: riskLevelSchema,
  origin: z.enum(['ENGINE', 'AI_ESCALATION', 'USER_ALLOWLIST']),
  reviewRequired: z.boolean(),
  policyVersion: z.string().min(1).max(16),
});

/**
 * `assistant-focus/v1`: lo único que el Copilot envía a la IA sobre CyberSOC en cada turno.
 * Reutiliza los contextos ya acotados y anonimizados de S2/S3; nunca contenido de archivos.
 */
export const assistantFocusSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schema: z.literal(ASSISTANT_FOCUS_SCHEMA_ID),
    kind: z.literal('NONE'),
  }),
  z.strictObject({
    schema: z.literal(ASSISTANT_FOCUS_SCHEMA_ID),
    kind: z.literal('RESULT'),
    /** Hechos, top-20 de evidencias, traza de capas, zona y perfil. */
    result: aiContextSchema,
    decision: decisionSchema.nullable(),
    lastAnalysis: lastAnalysisSchema.nullable(),
  }),
  z.strictObject({
    schema: z.literal(ASSISTANT_FOCUS_SCHEMA_ID),
    kind: z.literal('JOB'),
    job: jobSummaryContextSchema,
    lastSummary: jobSummarySchema.nullable(),
  }),
]);

export type AssistantFocus = z.infer<typeof assistantFocusSchema>;

export interface FocusRef {
  resultId?: string;
  jobId?: string;
}

export interface BuiltAssistantFocus {
  focus: AssistantFocus;
  /** JSON exacto que va entre <contexto> y </contexto>. */
  json: string;
  /** Para la UI ("Hablando de: …"). Es local: no se envía a la IA. */
  label: string | null;
}

// Lo que ScanOrchestrator guarda en scan_jobs.profile_json (T3.5).
const storedProfileSchema = z.union([
  z.object({
    mode: z.literal('AUTO'),
    profiles: z.record(
      z.string(),
      z.object({ layers: z.array(engineLayerSchema).min(1) }),
    ),
  }),
  z.object({
    mode: z.literal('CUSTOM'),
    profile: z.object({ layers: z.array(engineLayerSchema).min(1) }),
  }),
]);

/** Perfil de capas que se aplicó al archivo, o null si el escaneo no guardó perfil. */
export function profileFor(
  profileJson: string | null,
  zone: string | null,
): AIContext['profile'] | null {
  if (!profileJson) return null;
  let parsed;
  try {
    parsed = storedProfileSchema.safeParse(JSON.parse(profileJson));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const stored = parsed.data;
  if (stored.mode === 'CUSTOM')
    return { name: 'Personalizado', layers: stored.profile.layers };
  const zoneProfile = zone ? stored.profiles[zone] : undefined;
  return zoneProfile
    ? { name: `Automático por zona ${zone}`, layers: zoneProfile.layers }
    : null;
}

/** Construye el foco del Copilot leyendo SQLite. No escribe nada. */
export class AssistantFocusBuilder {
  constructor(
    private readonly db: Database,
    private readonly readConfig: () => Pick<AppConfig, 'ai'>,
  ) {}

  build(ref: FocusRef = {}): BuiltAssistantFocus {
    if (ref.resultId !== undefined && ref.jobId !== undefined)
      throw new TypeError('El foco es un resultado o un escaneo, no ambos.');
    if (ref.resultId !== undefined) return this.forResult(ref.resultId);
    if (ref.jobId !== undefined) return this.forJob(ref.jobId);
    return this.finish(
      { schema: ASSISTANT_FOCUS_SCHEMA_ID, kind: 'NONE' },
      null,
    );
  }

  private forResult(resultId: string): BuiltAssistantFocus {
    // Lanza si el resultado no existe. Mismos hechos que el análisis por archivo (S2/S3).
    const { result, analysis } = new AIAnalysisStore(this.db).load(resultId);
    const job = new ScanJobRepository(this.db).get(result.jobId);
    const zone = zoneSchema.safeParse(result.zone);
    const context = new AIContextBuilder(this.readConfig).build(result, {
      ...analysis,
      zone: zone.success ? zone.data : null,
      profile: profileFor(job?.profileJson ?? null, result.zone),
    }).context;

    const risk = new RiskAssessmentRepository(this.db).get(resultId);
    const decision = risk
      ? {
          finalVerdict: risk.finalVerdict,
          finalLevel: risk.finalLevel,
          origin: risk.origin,
          reviewRequired: risk.reviewRequired,
          policyVersion: risk.policyVersion,
        }
      : null;

    return this.finish(
      {
        schema: ASSISTANT_FOCUS_SCHEMA_ID,
        kind: 'RESULT',
        result: context,
        decision,
        lastAnalysis: this.lastAnalysis(resultId),
      },
      result.fileName,
    );
  }

  private forJob(jobId: string): BuiltAssistantFocus {
    const store = new JobSummaryStore(this.db);
    const facts = store.facts(jobId); // Lanza si el escaneo no existe.
    const { sendFileNames } = this.readConfig().ai;
    return this.finish(
      {
        schema: ASSISTANT_FOCUS_SCHEMA_ID,
        kind: 'JOB',
        job: buildJobSummaryContext(facts, { sendFileNames }).context,
        lastSummary: store.latestValid(jobId)?.summary ?? null,
      },
      facts.job.targetPath,
    );
  }

  /** Último análisis VALID del resultado; null si no hay o si ya no cumple el esquema. */
  private lastAnalysis(resultId: string) {
    const saved = new AIAnalysisRepository(this.db).latestValidByResult(
      resultId,
    );
    if (!saved?.responseJson) return null;
    try {
      const parsed = aiAssessmentSchema.safeParse(
        JSON.parse(saved.responseJson),
      );
      if (!parsed.success) return null;
      // strip() descarta la clave `schema`, que lastAnalysisSchema no tiene.
      return lastAnalysisSchema.strip().parse(parsed.data);
    } catch {
      return null;
    }
  }

  private finish(
    draft: AssistantFocus,
    label: string | null,
  ): BuiltAssistantFocus {
    // Lanza si algo no cumple el esquema: es preferible a enviar un foco inválido.
    const focus = assistantFocusSchema.parse(draft);
    return { focus, json: toPromptSafeJson(focus), label };
  }
}

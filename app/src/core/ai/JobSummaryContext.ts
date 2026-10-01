import { createHash } from 'node:crypto';
import {
  anonymizePath,
  pseudonymFor,
  toPromptSafeJson,
  truncateMiddle,
} from './AIContextBuilder';
import {
  AI_CONTEXT_LIMITS,
  JOB_SUMMARY_CONTEXT_LIMITS as L,
  JOB_SUMMARY_CONTEXT_SCHEMA_ID,
  jobSummaryContextSchema,
  type JobSummaryContext,
} from './schemas';

type Verdict = JobSummaryContext['topResults'][number]['verdict'];
type EvidenceFact = JobSummaryContext['topResults'][number]['evidence'][number];

/** Hechos de un escaneo terminado, leídos de SQLite por `JobSummaryStore`. */
export interface JobSummaryFacts {
  job: {
    id: string;
    targetPath: string;
    targetKind: 'FILE' | 'FOLDER';
    startedAt: string | null;
    finishedAt: string | null;
    filesDiscovered: number;
    filesProcessed: number;
    filesError: number;
    filesSkipped: number;
  };
  /** Resultados por veredicto final (los que falten cuentan 0). */
  verdicts: Partial<Record<Verdict, number>>;
  aiEscalations: number;
  reviewsRequired: number;
  /** Resultados de riesgo ya ordenados de mayor a menor; puede haber más de 10. */
  topResults: Array<{
    id: string;
    fileName: string;
    extension: string | null;
    verdict: Verdict;
    score: number | null;
    riskLevel: JobSummaryContext['topResults'][number]['riskLevel'];
    escalatedByAI: boolean;
    evidence: EvidenceFact[];
  }>;
}

export interface BuiltJobSummaryContext {
  context: JobSummaryContext;
  /** JSON exacto que se envía y se guarda en `ai_analyses.context_json`. */
  json: string;
  sha256: string;
}

function durationMs(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt || !finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
}

/**
 * Contexto de `JOB_SUMMARY`: contadores, duración y los 10 resultados de mayor riesgo con sus
 * códigos de evidencia. Igual que en el análisis por archivo: nunca contenido de archivos,
 * rutas anonimizadas y seudónimos si `ai.sendFileNames` es false.
 */
export function buildJobSummaryContext(
  facts: JobSummaryFacts,
  options: { sendFileNames: boolean },
): BuiltJobSummaryContext {
  const top = facts.topResults.slice(0, L.maxTopResults);
  const evidenceTruncated = top.some(
    (item) => item.evidence.length > L.maxEvidencePerResult,
  );
  const count = (verdict: Verdict) => facts.verdicts[verdict] ?? 0;

  const draft: JobSummaryContext = {
    schema: JOB_SUMMARY_CONTEXT_SCHEMA_ID,
    task: 'SUMMARIZE_SCAN_JOB',
    locale: 'es-CO',
    job: {
      jobId: facts.job.id,
      targetKind: facts.job.targetKind,
      targetLocation: truncateMiddle(
        anonymizePath(facts.job.targetPath),
        L.location,
      ),
      durationMs: durationMs(facts.job.startedAt, facts.job.finishedAt),
      counters: {
        filesDiscovered: facts.job.filesDiscovered,
        filesProcessed: facts.job.filesProcessed,
        filesError: facts.job.filesError,
        filesSkipped: facts.job.filesSkipped,
      },
      verdicts: {
        CLEAN: count('CLEAN'),
        SUSPICIOUS: count('SUSPICIOUS'),
        DETECTED: count('DETECTED'),
        NOT_ANALYZED: count('NOT_ANALYZED'),
        NOT_EVALUATED: count('NOT_EVALUATED'),
      },
      aiEscalations: facts.aiEscalations,
      reviewsRequired: facts.reviewsRequired,
    },
    topResults: top.map((item) => ({
      resultId: item.id,
      name: options.sendFileNames
        ? truncateMiddle(item.fileName, AI_CONTEXT_LIMITS.fileName)
        : pseudonymFor(item.id, item.extension),
      verdict: item.verdict,
      score: item.score,
      riskLevel: item.riskLevel,
      escalatedByAI: item.escalatedByAI,
      evidence: item.evidence.slice(0, L.maxEvidencePerResult).map((e) => ({
        source: e.source,
        code: e.code,
        severity: e.severity,
      })),
    })),
    constraints: {
      topResultsTruncated: facts.topResults.length > L.maxTopResults,
      evidenceTruncated,
      fileNamesPseudonymized: !options.sendFileNames,
      contentIncluded: false,
    },
  };

  // Lanza si los hechos no cumplen el esquema: es un error del llamador.
  const context = jobSummaryContextSchema.parse(draft);
  const json = toPromptSafeJson(context);
  return {
    context,
    json,
    sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
  };
}

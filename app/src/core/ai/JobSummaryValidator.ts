import {
  describeIssue,
  unsafeTextErrors,
  type AIValidationStatus,
} from './AIResponseValidator';
import {
  jobSummarySchema,
  type JobSummary,
  type JobSummaryContext,
} from './schemas';

export interface JobSummaryResponseInput {
  /** Texto exacto devuelto por el modelo. */
  rawText: string;
  /** La respuesta se cortó por `max_tokens`. */
  truncated: boolean;
  /** Contexto enviado: solo se usan los resultId de topResults. */
  context: Pick<JobSummaryContext, 'topResults'>;
}

export type JobSummaryValidationResult =
  | { status: 'VALID'; summary: JobSummary; errors: [] }
  | { status: Exclude<AIValidationStatus, 'VALID'>; errors: string[] };

type Failure = Exclude<JobSummaryValidationResult, { status: 'VALID' }>;

// Solo se repiten en la retroalimentación los ids con forma de identificador; cualquier otro
// texto inventado por el modelo se cuenta, pero no se copia.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fail(status: Failure['status'], errors: string[]): Failure {
  return { status, errors };
}

function check(input: JobSummaryResponseInput): JobSummaryValidationResult {
  // 1. JSON válido.
  let json: unknown;
  try {
    json = JSON.parse(input.rawText);
  } catch {
    return fail('INVALID_JSON', ['La respuesta no es JSON válido.']);
  }

  // 2. Esquema: { summary, highlights[{resultId, why}], recommendations[], citedResultIds[] }.
  const parsed = jobSummarySchema.safeParse(json);
  if (!parsed.success) {
    return fail('SCHEMA_ERROR', parsed.error.issues.map(describeIssue));
  }
  const value = parsed.data;

  // 3. Semántica: todos los resultId deben existir en el contexto enviado.
  const known = new Set(input.context.topResults.map((item) => item.resultId));
  const referenced = new Set([
    ...value.highlights.map((item) => item.resultId),
    ...value.citedResultIds,
  ]);
  const unknown = [...referenced].filter((id) => !known.has(id));
  if (unknown.length) {
    const shown = unknown.filter((id) => SAFE_ID.test(id)).slice(0, 5);
    return fail('UNKNOWN_EVIDENCE', [
      `${unknown.length} resultId no existen en el contexto${shown.length ? ` (${shown.join(', ')})` : ''}.`,
    ]);
  }

  // 4. Seguridad: las mismas reglas que el análisis por archivo (sin URLs ni comandos).
  const unsafe = unsafeTextErrors([
    { field: 'summary', text: value.summary },
    ...value.highlights.map((item, index) => ({
      field: `highlights.${index}.why`,
      text: item.why,
    })),
    ...value.recommendations.map((text, index) => ({
      field: `recommendations.${index}`,
      text,
    })),
  ]);
  if (unsafe.length) return fail('UNSAFE', unsafe);

  return { status: 'VALID', summary: value, errors: [] };
}

/**
 * Valida un `JOB_SUMMARY` con los mismos cinco pasos que el análisis por archivo:
 * JSON → esquema → resultId existentes → seguridad → completitud. Un resultId inventado da
 * UNKNOWN_EVIDENCE, el estado semántico de `ai_analyses.validation_status`.
 */
export function validateJobSummary(
  input: JobSummaryResponseInput,
): JobSummaryValidationResult {
  const result = check(input);
  // 5. Completitud: una respuesta cortada siempre es INCOMPLETE (remedio: más tokens).
  if (input.truncated) {
    return fail('INCOMPLETE', [
      'La respuesta se cortó por el límite de tokens.',
    ]);
  }
  return result;
}

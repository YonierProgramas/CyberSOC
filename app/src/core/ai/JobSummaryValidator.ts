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
  /** Exact text returned by the model. */
  rawText: string;
  /** The response was cut off by `max_tokens`. */
  truncated: boolean;
  /** Context sent: only the resultIds of topResults are used. */
  context: Pick<JobSummaryContext, 'topResults'>;
}

export type JobSummaryValidationResult =
  | { status: 'VALID'; summary: JobSummary; errors: [] }
  | { status: Exclude<AIValidationStatus, 'VALID'>; errors: string[] };

type Failure = Exclude<JobSummaryValidationResult, { status: 'VALID' }>;

// Only identifier-shaped ids are repeated in the feedback; any other
// text invented by the model is counted but not copied.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fail(status: Failure['status'], errors: string[]): Failure {
  return { status, errors };
}

function check(input: JobSummaryResponseInput): JobSummaryValidationResult {
  // 1. Valid JSON.
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

  // 3. Semantics: every resultId must exist in the context sent.
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

  // 4. Safety: the same rules as the per-file analysis (no URLs or commands).
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
 * Validates a `JOB_SUMMARY` with the same five steps as the per-file analysis:
 * JSON → schema → existing resultIds → safety → completeness. An invented resultId gives
 * UNKNOWN_EVIDENCE, the semantic status of `ai_analyses.validation_status`.
 */
export function validateJobSummary(
  input: JobSummaryResponseInput,
): JobSummaryValidationResult {
  const result = check(input);
  // 5. Completeness: a response cut off is always INCOMPLETE (remedy: more tokens).
  if (input.truncated) {
    return fail('INCOMPLETE', [
      'La respuesta se cortó por el límite de tokens.',
    ]);
  }
  return result;
}

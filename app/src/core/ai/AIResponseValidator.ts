import type { z } from 'zod';
import {
  aiAssessmentSchema,
  type AIAssessment,
  type AIContext,
} from './schemas';

/**
 * Validator result; same values as `ai_analyses.validation_status`, except
 * `PROVIDER_ERROR`, which the service assigns when the provider returned no response.
 */
export type AIValidationStatus =
  | 'VALID'
  | 'INVALID_JSON'
  | 'SCHEMA_ERROR'
  | 'UNKNOWN_EVIDENCE'
  | 'UNSAFE'
  | 'INCOMPLETE';

export interface AIResponseInput {
  /** Exact text returned by the model (provider `rawText`). */
  rawText: string;
  /** The response was cut off by `max_tokens` (provider INCOMPLETE error). */
  truncated: boolean;
  /** Context sent: only the ids of its evidence are used. */
  context: Pick<AIContext, 'evidence'>;
}

/**
 * `errors` are Spanish messages generated here, never copies of the AI text: they can be
 * sent back as feedback on the retry without reinjecting what the model wrote.
 */
export type AIValidationResult =
  | { status: 'VALID'; assessment: AIAssessment; errors: [] }
  | { status: Exclude<AIValidationStatus, 'VALID'>; errors: string[] };

type Failure = Exclude<AIValidationResult, { status: 'VALID' }>;
export type TextField = { field: string; text: string };

const EVIDENCE_REF = /\bev[1-9][0-9]*\b/g;
const MAX_LISTED = 5;

const URL_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // cualquier esquema://
  /\bwww\.[a-z0-9-]+\./i,
  /\b(?:javascript|vbscript|data|file|mailto):/i,
  /\\\\[\w.-]+\\[\w$.-]+/, // UNC path \\server\share
];

// Command syntax, not loose words: mentioning "PowerShell" or "el registro" is valid.
const COMMAND_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['PowerShell', /\b(?:powershell|pwsh)(?:\.exe)?\s+[-/]\w/i],
  [
    'cmdlet de PowerShell',
    /\b(?:Invoke|Remove|Set|Start|Stop|New|Add|Get|Copy|Move|Rename|Clear|Out|Disable|Enable|Register|Unregister|Import|Export|Expand|Compress)-[A-Z][A-Za-z]+\b/,
  ],
  ['PowerShell', /\biex\b|-EncodedCommand\b|\s-enc\s/i],
  ['cmd', /\bcmd(?:\.exe)?\s+\/[ckr]\b/i],
  [
    'reg',
    /\breg(?:\.exe)?\s+(?:add|delete|import|export|query|load|unload|copy|save|restore)\b/i,
  ],
  [
    'herramienta de sistema',
    // Name followed by a flag (-x or /x) within the next two tokens: "wscript ejecuta el
    // archivo" is valid prose; "certutil -urlcache -f …" is a command.
    /\b(?:certutil|bitsadmin|mshta|rundll32|regsvr32|schtasks|wmic|vssadmin|bcdedit|icacls|takeown|wscript|cscript|msiexec|netsh)(?:\.exe)?\s+(?:\S+\s+)?[-/][a-z]/i,
  ],
  [
    'herramienta de sistema',
    /\brundll32(?:\.exe)?\s+\S+\.dll,|\bvssadmin(?:\.exe)?\s+delete\b/i,
  ],
  ['borrado', /\b(?:del|erase|rd|rmdir)\s+\/[sqfa]\b|\brm\s+-[rf]/i],
];

const ISSUE_TEXT: Record<string, string> = {
  invalid_type: 'tipo incorrecto',
  invalid_value: 'valor fuera de las opciones permitidas',
  invalid_format: 'formato inválido',
  unrecognized_keys: 'contiene claves no permitidas',
};

function fail(status: Failure['status'], errors: string[]): Failure {
  return { status, errors };
}

/** Describes a zod error without copying response values (only the path and the schema limit). */
export function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length ? issue.path.join('.') : '(raíz)';
  let detail = ISSUE_TEXT[issue.code] ?? 'no cumple el esquema';
  if (issue.code === 'too_big') detail = `supera el máximo (${issue.maximum})`;
  if (issue.code === 'too_small')
    detail = `por debajo del mínimo (${issue.minimum})`;
  return `Campo ${path}: ${detail}.`;
}

function textFields(value: AIAssessment): TextField[] {
  return [
    { field: 'summary', text: value.summary },
    { field: 'plainExplanation', text: value.plainExplanation },
    { field: 'technicalAnalysis', text: value.technicalAnalysis },
    ...value.correlations.map((item, index) => ({
      field: `correlations.${index}.insight`,
      text: item.insight,
    })),
    { field: 'actionRationale', text: value.actionRationale },
    { field: 'falsePositiveNotes', text: value.falsePositiveNotes },
  ];
}

function listed(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(', ');
  return ids.length > MAX_LISTED ? `${shown}…` : shown;
}

/** Steps 1 to 4, in order: the first one that fails decides the status. */
function checkContent(input: AIResponseInput): AIValidationResult {
  // 1. Valid JSON.
  let json: unknown;
  try {
    json = JSON.parse(input.rawText);
  } catch {
    return fail('INVALID_JSON', ['La respuesta no es JSON válido.']);
  }

  // 2. Zod schema (including enums and maximum lengths), in addition to the provider JSON Schema.
  const parsed = aiAssessmentSchema.safeParse(json);
  if (!parsed.success) {
    return fail('SCHEMA_ERROR', parsed.error.issues.map(describeIssue));
  }
  const value = parsed.data;

  // 3. Semantics: every evidence reference exists and there is at least one citation.
  const known = new Set(input.context.evidence.map((item) => item.id));
  const referenced = new Set([
    ...value.citedEvidenceIds,
    ...value.correlations.flatMap((item) => item.evidenceIds),
    ...textFields(value).flatMap(({ text }) => text.match(EVIDENCE_REF) ?? []),
  ]);
  const unknown = [...referenced].filter((id) => !known.has(id));
  const semantic: string[] = [];
  if (unknown.length) {
    semantic.push(
      `Evidencias que no existen en el contexto: ${listed(unknown)}.`,
    );
  }
  if (
    value.opinion !== 'INSUFFICIENT_EVIDENCE' &&
    value.citedEvidenceIds.length === 0
  ) {
    semantic.push(
      'Falta citar al menos una evidencia (solo INSUFFICIENT_EVIDENCE puede no citar).',
    );
  }
  if (semantic.length) return fail('UNKNOWN_EVIDENCE', semantic);

  // 4. Safety: no URLs or commands. Maximum lengths and the action enum are already
  //    enforced by the schema in step 2.
  const unsafe = unsafeTextErrors(textFields(value));
  if (unsafe.length) return fail('UNSAFE', unsafe);

  return { status: 'VALID', assessment: value, errors: [] };
}

/**
 * Reusable step 4 (also used by the JOB_SUMMARY validator): one error per field with a
 * URL or command. Messages name the field and the category, never the text found.
 */
export function unsafeTextErrors(fields: readonly TextField[]): string[] {
  const unsafe: string[] = [];
  for (const { field, text } of fields) {
    if (URL_PATTERNS.some((pattern) => pattern.test(text))) {
      unsafe.push(`Campo ${field}: contiene una URL o enlace.`);
    }
    const command = COMMAND_PATTERNS.find(([, pattern]) => pattern.test(text));
    if (command) {
      unsafe.push(`Campo ${field}: contiene un comando (${command[0]}).`);
    }
  }
  return unsafe;
}

/**
 * Validates an `ai-assessment/v1` response with the five S2 plan steps, in order:
 * JSON → schema → semantics → safety → completeness.
 *
 * A response cut off by `max_tokens` is always INCOMPLETE: its failure in an earlier step
 * (almost always broken JSON) is a symptom, and the remedy differs (retry with more tokens).
 */
export function validateAIResponse(input: AIResponseInput): AIValidationResult {
  const result = checkContent(input);
  // 5. Completitud.
  if (input.truncated) {
    return fail('INCOMPLETE', [
      'La respuesta se cortó por el límite de tokens.',
    ]);
  }
  return result;
}

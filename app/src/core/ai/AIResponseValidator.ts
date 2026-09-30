import type { z } from 'zod';
import {
  aiAssessmentSchema,
  type AIAssessment,
  type AIContext,
} from './schemas';

/**
 * Resultado del validador; mismos valores que `ai_analyses.validation_status`, salvo
 * `PROVIDER_ERROR`, que lo asigna el servicio cuando el proveedor no devolvió respuesta.
 */
export type AIValidationStatus =
  | 'VALID'
  | 'INVALID_JSON'
  | 'SCHEMA_ERROR'
  | 'UNKNOWN_EVIDENCE'
  | 'UNSAFE'
  | 'INCOMPLETE';

export interface AIResponseInput {
  /** Texto exacto devuelto por el modelo (`rawText` del proveedor). */
  rawText: string;
  /** La respuesta se cortó por `max_tokens` (error INCOMPLETE del proveedor). */
  truncated: boolean;
  /** Contexto enviado: solo se usan los ids de sus evidencias. */
  context: Pick<AIContext, 'evidence'>;
}

/**
 * `errors` son mensajes en español generados aquí, nunca copias del texto de la IA: se pueden
 * reenviar como retroalimentación en el reintento sin reinyectar lo que escribió el modelo.
 */
export type AIValidationResult =
  | { status: 'VALID'; assessment: AIAssessment; errors: [] }
  | { status: Exclude<AIValidationStatus, 'VALID'>; errors: string[] };

type Failure = Exclude<AIValidationResult, { status: 'VALID' }>;
type TextField = { field: string; text: string };

const EVIDENCE_REF = /\bev[1-9][0-9]*\b/g;
const MAX_LISTED = 5;

const URL_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // cualquier esquema://
  /\bwww\.[a-z0-9-]+\./i,
  /\b(?:javascript|vbscript|data|file|mailto):/i,
  /\\\\[\w.-]+\\[\w$.-]+/, // ruta UNC \\servidor\recurso
];

// Sintaxis de comandos, no palabras sueltas: mencionar "PowerShell" o "el registro" es válido.
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
    // Nombre seguido de un flag (-x o /x) en los dos siguientes tokens: "wscript ejecuta el
    // archivo" es prosa válida; "certutil -urlcache -f …" es un comando.
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

function describeIssue(issue: z.core.$ZodIssue): string {
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

/** Pasos 1 a 4, en orden: el primero que falla decide el estado. */
function checkContent(input: AIResponseInput): AIValidationResult {
  // 1. JSON válido.
  let json: unknown;
  try {
    json = JSON.parse(input.rawText);
  } catch {
    return fail('INVALID_JSON', ['La respuesta no es JSON válido.']);
  }

  // 2. Esquema zod (enums y longitudes máximas incluidos), además del JSON Schema del proveedor.
  const parsed = aiAssessmentSchema.safeParse(json);
  if (!parsed.success) {
    return fail('SCHEMA_ERROR', parsed.error.issues.map(describeIssue));
  }
  const value = parsed.data;

  // 3. Semántica: toda referencia a evidencia existe y hay al menos una cita.
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

  // 4. Seguridad: sin URLs ni comandos. Las longitudes máximas y el enum de la acción ya los
  //    hace cumplir el esquema del paso 2.
  const unsafe: string[] = [];
  for (const { field, text } of textFields(value)) {
    if (URL_PATTERNS.some((pattern) => pattern.test(text))) {
      unsafe.push(`Campo ${field}: contiene una URL o enlace.`);
    }
    const command = COMMAND_PATTERNS.find(([, pattern]) => pattern.test(text));
    if (command) {
      unsafe.push(`Campo ${field}: contiene un comando (${command[0]}).`);
    }
  }
  if (unsafe.length) return fail('UNSAFE', unsafe);

  return { status: 'VALID', assessment: value, errors: [] };
}

/**
 * Valida una respuesta de `ai-assessment/v1` con los cinco pasos del plan de S2, en orden:
 * JSON → esquema → semántica → seguridad → completitud.
 *
 * Una respuesta cortada por `max_tokens` es siempre INCOMPLETE: su fallo en un paso anterior
 * (casi siempre JSON roto) es un síntoma, y el remedio es otro (reintentar con más tokens).
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

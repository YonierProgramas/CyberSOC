import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { AppConfig } from '../config/AppConfig';
import {
  AI_CONTEXT_LIMITS,
  AI_CONTEXT_SCHEMA_ID,
  aiContextSchema,
  type AIContext,
} from './schemas';

/**
 * Hechos de un resultado que el builder puede usar. `ScanResultRecord` (T1.3) lo cumple
 * estructuralmente. No hay ningún campo de contenido: el builder no puede enviarlo.
 */
export interface ScanResultFacts {
  id: string;
  path: string;
  fileName: string;
  extension: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  verdict: AIContext['engine']['verdict'];
}

export interface BuiltAIContext {
  context: AIContext;
  /** JSON exacto que se envía a la IA y se guarda en `ai_analyses.context_json`. */
  json: string;
  /** SHA-256 (hex) de `json` en UTF-8: `ai_analyses.context_sha256`. */
  sha256: string;
}

const ELLIPSIS = '…';
const USER_PROFILE_ROOT = /^[A-Za-z]:\\+users\\+([^\\]+)(?=\\|$)/i;
// Perfiles compartidos de Windows: no identifican a nadie.
const SHARED_PROFILES = new Set([
  'public',
  'default',
  'default user',
  'all users',
]);
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

/**
 * Sustituye `C:\Users\<usuario>` por `%USERPROFILE%` (cualquier unidad, sin distinguir
 * mayúsculas). Normaliza `/` a `\` y quita el prefijo de ruta larga `\\?\`.
 */
export function anonymizePath(path: string): string {
  const normalized = path
    .replace(/\//g, '\\')
    .replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
  const match = USER_PROFILE_ROOT.exec(normalized);
  if (!match || SHARED_PROFILES.has(match[1]!.toLowerCase())) return normalized;
  return `%USERPROFILE%${normalized.slice(match[0].length)}`;
}

/**
 * Recorta `value` a `max` unidades UTF-16 conservando el inicio y el final, sin partir pares
 * sustitutos. El final se conserva porque ahí está la extensión real (`factura.pdf     .exe`).
 */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const budget = max - ELLIPSIS.length;
  const tailBudget = Math.floor(budget / 2);
  const headBudget = budget - tailBudget;
  const chars = Array.from(value);
  let head = '';
  for (const char of chars) {
    if (head.length + char.length > headBudget) break;
    head += char;
  }
  let tail = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i]!;
    if (tail.length + char.length > tailBudget) break;
    tail = char + tail;
  }
  return head + ELLIPSIS + tail;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Seudónimo estable por resultado; solo conserva la extensión si es inofensiva. */
export function pseudonymFor(
  resultId: string,
  extension: string | null,
): string {
  const suffix = extension && SAFE_EXTENSION.test(extension) ? extension : '';
  return `archivo-${sha256Hex(resultId).slice(0, 8)}${suffix}`;
}

/**
 * Construye `ai-context/v1` (v0: solo los hechos del archivo, sin evidencias ni traza).
 * Todo texto del resultado viaja como dato dentro de su campo; nunca se interpreta.
 */
export class AIContextBuilder {
  constructor(private readonly readConfig: () => Pick<AppConfig, 'ai'>) {}

  build(result: ScanResultFacts): BuiltAIContext {
    const { sendFileNames } = this.readConfig().ai;
    let fieldsTruncated = false;
    const limit = (value: string, max: number): string => {
      const out = truncateMiddle(value, max);
      if (out !== value) fieldsTruncated = true;
      return out;
    };
    const L = AI_CONTEXT_LIMITS;

    const name = sendFileNames
      ? limit(result.fileName, L.fileName)
      : pseudonymFor(result.id, result.extension);
    const location = limit(
      anonymizePath(win32.dirname(result.path)),
      L.location,
    );

    const draft: AIContext = {
      schema: AI_CONTEXT_SCHEMA_ID,
      task: 'ANALYZE_FILE_RESULT',
      locale: 'es-CO',
      file: {
        resultId: result.id,
        name,
        extension:
          result.extension === null
            ? null
            : limit(result.extension, L.extension),
        detectedType: null,
        typeMatchesExtension: null,
        sizeBytes: result.sizeBytes,
        location,
        sha256: result.sha256?.toLowerCase() ?? null,
      },
      engine: {
        engineVersion: null,
        signaturesVersion: null,
        verdict: result.verdict,
        score: null,
        riskLevel: null,
        scoreBreakdown: [],
      },
      evidence: [],
      constraints: {
        evidenceTruncated: false,
        fieldsTruncated,
        fileNamePseudonymized: !sendFileNames,
        contentIncluded: false,
      },
    };

    // Lanza si el resultado no cumple el esquema (p. ej. un SHA-256 mal formado): es un error
    // del llamador y es preferible a enviar un contexto inválido.
    const context = aiContextSchema.parse(draft);
    const json = JSON.stringify(context);
    return { context, json, sha256: sha256Hex(json) };
  }
}

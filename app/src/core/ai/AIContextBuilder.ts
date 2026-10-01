import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { AppConfig } from '../config/AppConfig';
import type { Evidence, LayerTrace } from '../../shared/protocol';
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

export interface AnalysisFacts {
  evidence: readonly Evidence[];
  layers: readonly LayerTrace[];
  engineVersion: string | null;
  signaturesVersion: string | null;
  score: number | null;
  riskLevel: AIContext['engine']['riskLevel'];
  detectedType: string | null;
  timesSeenBefore: number;
  /** Zona del archivo (D15). Hoy solo la añade el foco del Copilot (S4). */
  zone?: NonNullable<AIContext['file']['zone']> | null;
  /** Perfil de capas aplicado (D15). Hoy solo lo añade el foco del Copilot (S4). */
  profile?: AIContext['profile'] | null;
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
 * Construye `ai-context/v1` con hechos, top-20 de evidencias, capas e historial.
 * Sin `analysis` conserva la forma inicial para lectores anteriores.
 * Todo texto del resultado viaja como dato dentro de su campo; nunca se interpreta.
 */
export class AIContextBuilder {
  constructor(private readonly readConfig: () => Pick<AppConfig, 'ai'>) {}

  build(result: ScanResultFacts, analysis?: AnalysisFacts): BuiltAIContext {
    const { sendFileNames } = this.readConfig().ai;
    let fieldsTruncated = false;
    const limit = (value: string, max: number): string => {
      const out = truncateMiddle(value, max);
      if (out !== value) fieldsTruncated = true;
      return out;
    };
    const L = AI_CONTEXT_LIMITS;
    // Top-20: ordenar una copia cuesta O(n log n) tiempo y O(n) espacio.
    // El orden estable conserva el orden del motor cuando hay empate de puntos.
    const selected = [...(analysis?.evidence ?? [])]
      .sort((a, b) => b.points - a.points)
      .slice(0, L.maxEvidence);
    const evidence = selected.map((item) => ({
      id: item.id,
      source: item.source,
      code: item.code,
      severity: item.severity,
      // No se serializa facts: podría contener datos arbitrarios o contenido.
      summary: limit(
        sendFileNames
          ? item.title.replace(
              /[A-Za-z]:[\\/]+users[\\/]+[^\\/\s]+/gi,
              '%USERPROFILE%',
            )
          : `${item.code} (${item.severity})`,
        L.evidenceSummary,
      ),
    }));
    const layers = analysis?.layers.map((item) => ({
      layer: item.layer,
      status: item.status,
      hits: item.hits,
      ...(item.reason ? { reason: limit(item.reason, L.layerReason) } : {}),
    }));

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
        detectedType:
          analysis?.detectedType == null
            ? null
            : limit(analysis.detectedType, L.detectedType),
        typeMatchesExtension: analysis?.evidence.some(
          (e) => e.code === 'TYPE_MISMATCH',
        )
          ? false
          : null,
        sizeBytes: result.sizeBytes,
        location,
        sha256: result.sha256?.toLowerCase() ?? null,
        ...(analysis?.zone ? { zone: analysis.zone } : {}),
      },
      engine: {
        engineVersion:
          analysis?.engineVersion == null
            ? null
            : limit(analysis.engineVersion, L.version),
        signaturesVersion:
          analysis?.signaturesVersion == null
            ? null
            : limit(analysis.signaturesVersion, L.version),
        verdict: result.verdict,
        score: analysis?.score ?? null,
        riskLevel: analysis?.riskLevel ?? null,
        scoreBreakdown: selected.map((item) => ({
          evidenceId: item.id,
          points: item.points,
        })),
      },
      evidence,
      ...(analysis
        ? { layers, history: { timesSeenBefore: analysis.timesSeenBefore } }
        : {}),
      ...(analysis?.profile
        ? {
            profile: {
              name: limit(analysis.profile.name, L.profileName),
              layers: [...analysis.profile.layers],
            },
          }
        : {}),
      constraints: {
        evidenceTruncated: (analysis?.evidence.length ?? 0) > L.maxEvidence,
        fieldsTruncated,
        fileNamePseudonymized: !sendFileNames,
        contentIncluded: false,
      },
    };

    // Lanza si el resultado no cumple el esquema (p. ej. un SHA-256 mal formado): es un error
    // del llamador y es preferible a enviar un contexto inválido.
    const context = aiContextSchema.parse(draft);
    const json = toPromptSafeJson(context);
    return { context, json, sha256: sha256Hex(json) };
  }
}

/**
 * `JSON.stringify` con `<`, `>` y `&` escritos como escapes Unicode de JSON (barra invertida,
 * `u` y el código hexadecimal: 003c, 003e y 0026). El JSON parseado es idéntico, pero un campo
 * hostil no puede cerrar la etiqueta <contexto> del prompt.
 */
export function toPromptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

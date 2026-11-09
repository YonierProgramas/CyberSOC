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
 * Facts of a result the builder may use. `ScanResultRecord` (T1.3) satisfies this
 * structurally. There is no content field: the builder cannot send one.
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
  /** Exact JSON sent to the AI and stored in `ai_analyses.context_json`. */
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
  /** File zone (D15). Currently only added by the Copilot focus (S4). */
  zone?: NonNullable<AIContext['file']['zone']> | null;
  /** Applied layer profile (D15). Currently only added by the Copilot focus (S4). */
  profile?: AIContext['profile'] | null;
}

const ELLIPSIS = '…';
const USER_PROFILE_ROOT = /^[A-Za-z]:\\+users\\+([^\\]+)(?=\\|$)/i;
// Shared Windows profiles: they identify nobody.
const SHARED_PROFILES = new Set([
  'public',
  'default',
  'default user',
  'all users',
]);
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

/**
 * Replaces `C:\Users\<user>` with `%USERPROFILE%` (any drive, case
 * insensitive). Normalizes `/` to `\` and removes the long-path prefix `\\?\`.
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
 * Trims `value` to `max` UTF-16 units keeping the start and end, without splitting surrogate
 * pairs. The end is kept because it holds the real extension (`factura.pdf     .exe`).
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

/** Stable pseudonym per result; keeps the extension only if it is harmless. */
export function pseudonymFor(
  resultId: string,
  extension: string | null,
): string {
  const suffix = extension && SAFE_EXTENSION.test(extension) ? extension : '';
  return `archivo-${sha256Hex(resultId).slice(0, 8)}${suffix}`;
}

/**
 * Builds `ai-context/v1` with facts, top-20 evidence, layers and history.
 * Without `analysis` it keeps the initial shape for earlier readers.
 * All result text travels as data inside its field; it is never interpreted.
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
    // Top-20: sorting a copy costs O(n log n) time and O(n) space.
    // The stable sort keeps the engine order when points are tied.
    const selected = [...(analysis?.evidence ?? [])]
      .sort((a, b) => b.points - a.points)
      .slice(0, L.maxEvidence);
    const evidence = selected.map((item) => ({
      id: item.id,
      source: item.source,
      code: item.code,
      severity: item.severity,
      // facts is not serialized: it could contain arbitrary data or content.
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

    // Throws if the result does not match the schema (e.g. a malformed SHA-256): that is a
    // caller error and is preferable to sending an invalid context.
    const context = aiContextSchema.parse(draft);
    const json = toPromptSafeJson(context);
    return { context, json, sha256: sha256Hex(json) };
  }
}

/**
 * `JSON.stringify` with `<`, `>` and `&` written as JSON Unicode escapes (backslash,
 * `u` and the hex code: 003c, 003e and 0026). The parsed JSON is identical, but a hostile
 * field cannot close the <contexto> tag of the prompt.
 */
export function toPromptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

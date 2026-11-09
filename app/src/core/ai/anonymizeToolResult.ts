import { anonymizePath } from './AIContextBuilder';

// Absolute Windows path (C:\…, C:/…) or with the long prefix \\?\C:\…
const WINDOWS_PATH = /^(?:\\\\\?\\)?[A-Za-z]:[\\/]/;

/**
 * Copy of a tool result ready to be sent to the AI provider (AUD-04).
 * Every text that is a Windows path goes through anonymizePath: C:\Users\<person> becomes
 * %USERPROFILE%, also inside nested objects and lists (path,
 * targetPath, originalPath, paths…). Other texts are left untouched.
 *
 * It only affects what travels to the provider. The Core keeps using the original result:
 * for example, the plan validator takes the real paths from its own list_zones.
 * Depth-first traversal: O(n) in the number of values of the result.
 */
export function anonymizeToolResult<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === 'string')
    return WINDOWS_PATH.test(value) ? anonymizePath(value) : value;
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = walk(item);
    return copy;
  }
  return value;
}

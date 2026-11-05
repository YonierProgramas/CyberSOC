import { anonymizePath } from './AIContextBuilder';

// Ruta absoluta de Windows (C:\…, C:/…) o con prefijo largo \\?\C:\…
const WINDOWS_PATH = /^(?:\\\\\?\\)?[A-Za-z]:[\\/]/;

/**
 * Copia del resultado de una herramienta lista para enviarse al proveedor de IA (AUD-04).
 * Cada texto que es una ruta de Windows pasa por anonymizePath: C:\Users\<persona> se
 * convierte en %USERPROFILE%, también dentro de objetos y listas anidados (path,
 * targetPath, originalPath, paths…). Los demás textos no se tocan.
 *
 * Solo afecta a lo que viaja al proveedor. El Core sigue usando el resultado original:
 * por ejemplo, el validador de planes toma las rutas reales de su propio list_zones.
 * Recorrido en profundidad: O(n) en el número de valores del resultado.
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

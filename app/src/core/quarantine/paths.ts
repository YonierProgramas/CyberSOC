import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve, win32 } from 'node:path';

export class QuarantineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function normalizedPath(path: string): string {
  return (win32.isAbsolute(path) ? win32.normalize(path) : resolve(path))
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
export function validatePath(path: string): string {
  if (!path || path.includes('\0') || path.split(/[\\/]/).includes('..'))
    throw new QuarantineError(
      'INVALID_PATH',
      'Ruta inválida: no se permite path traversal.',
    );
  if (/^[\\/]{2}/.test(path) || /^\\[?.]/.test(path))
    throw new QuarantineError(
      'INVALID_PATH',
      'No se admiten rutas de red ni dispositivos.',
    );
  const windows = process.platform === 'win32' || /^[a-z]:/i.test(path);
  if (windows) {
    if (!/^[a-z]:[\\/]/i.test(path))
      throw new QuarantineError(
        'INVALID_PATH',
        'Se requiere una ruta absoluta con unidad.',
      );
    for (const part of path.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (
        part === '.' ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)
      )
        throw new QuarantineError('INVALID_PATH', 'Segmento de ruta inseguro.');
    }
    return win32.normalize(path);
  }
  if (!isAbsolute(path))
    throw new QuarantineError('INVALID_PATH', 'Se requiere una ruta absoluta.');
  return resolve(path);
}

/** Set: invariante, cada prefijo es absoluto, único y normalizado.
 * Insertar/consultar un prefijo exacto cuesta O(1) promedio tras normalizar.
 * Proteger por prefijo exige recorrer p entradas: O(p·L), L longitud de ruta.
 * El separador es frontera de segmento: C:\\Win NO protege C:\\Windows.
 */
export class ProtectedPaths {
  readonly prefixes: ReadonlySet<string>;
  constructor(extra: readonly string[]) {
    this.prefixes = new Set(
      [
        'C:\\Windows',
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        'C:\\ProgramData\\Microsoft',
        ...extra,
      ].flatMap((path) => {
        try {
          return [normalizedPath(path), normalizedPath(realpathSync(path))];
        } catch {
          return [normalizedPath(path)];
        }
      }),
    );
  }
  assertAllowed(path: string): void {
    const candidate = normalizedPath(path);
    for (const prefix of this.prefixes) {
      if (candidate === prefix || candidate.startsWith(`${prefix}/`))
        throw new QuarantineError('PROTECTED_PATH', 'La ruta está protegida.');
    }
  }
}

/** Rechaza enlaces/junctions en todos los ancestros, no solo en el último nombre. */
export async function assertNoLinks(path: string): Promise<void> {
  let current = path;
  const root = parse(current).root;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new QuarantineError(
        'UNSAFE_LINK',
        'No se admiten enlaces ni junctions.',
      );
    if (current === root) break;
    current = dirname(current);
  }
  // realpath puede expandir nombres Windows 8.3 sin que haya un enlace.
  // El llamador vuelve a comprobar los prefijos sobre esa ruta canónica.
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

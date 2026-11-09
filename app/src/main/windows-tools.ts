import { win32 } from 'node:path';

/** Uses OS modules already loaded by Windows (KnownDLLs), never PATH/cwd/env.
 * getReport only builds an in-memory object: the full report is neither written
 * nor logged, since it could contain private process variables.
 * Linear search O(n), O(1) memory aside from the runtime report.
 */
export function windowsPowerShellPath(
  modules: readonly string[] = (
    process.report.getReport() as { sharedObjects?: string[] }
  ).sharedObjects ?? [],
): string {
  const kernel = modules.find((path) =>
    /[\\/]system32[\\/]kernel32\.dll$/i.test(path),
  );
  const native = modules.find((path) =>
    /[\\/]system32[\\/]ntdll\.dll$/i.test(path),
  );
  if (
    !kernel ||
    !native ||
    !win32.isAbsolute(kernel) ||
    win32.dirname(kernel).toLowerCase() !== win32.dirname(native).toLowerCase()
  ) {
    throw new Error(
      'No se pudo identificar la ruta de herramientas de Windows.',
    );
  }
  return win32.join(
    win32.dirname(kernel),
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

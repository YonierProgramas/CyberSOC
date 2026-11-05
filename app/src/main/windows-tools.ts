import { win32 } from 'node:path';

/** Usa módulos del SO ya cargados por Windows (KnownDLLs), nunca PATH/cwd/env.
 * getReport solo construye un objeto en memoria: no se escribe ni registra el
 * informe completo, que podría contener variables privadas del proceso.
 * Búsqueda lineal O(n), memoria O(1) aparte del informe del runtime.
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

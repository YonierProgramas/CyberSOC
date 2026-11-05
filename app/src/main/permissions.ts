// Permisos web que la ventana puede conceder (B-06 de 11.B). Electron concede por defecto
// casi todo lo que pida la página: cámara, micrófono, notificaciones, ubicación…
// La interfaz solo necesita copiar un hash al portapapeles, así que todo lo demás se niega.
// Set: consulta O(1) promedio; la lista es cerrada y no se amplía en tiempo de ejecución.
const allowedPermissions: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
]);

export function isPermissionAllowed(permission: string): boolean {
  return allowedPermissions.has(permission);
}

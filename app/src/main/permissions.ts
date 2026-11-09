// Web permissions the window may grant (B-06 of 11.B). Electron grants by default
// almost everything the page asks for: camera, microphone, notifications, location…
// The UI only needs to copy a hash to the clipboard, so everything else is denied.
// Set: O(1) average lookup; the list is closed and does not grow at runtime.
const allowedPermissions: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
]);

export function isPermissionAllowed(permission: string): boolean {
  return allowedPermissions.has(permission);
}

// Electron rewrites errors thrown by main handlers as
// "Error invoking remote method 'channel': Error: message". Only the message
// written by the app is meant for the person using it, and that text is in Spanish.
const REMOTE_ERROR_PREFIX =
  /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

/** Text to show for a failed IPC call, or `fallback` when there is no usable message. */
export function ipcErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(REMOTE_ERROR_PREFIX, '') || fallback;
}

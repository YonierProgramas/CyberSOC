import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { scanProfileChoiceSchema } from '../../shared/scan-profile';

export const noArguments = z.tuple([]);
export const scanTargetSchema = z.strictObject({
  profile: scanProfileChoiceSchema.optional(),
  kind: z.enum(['FILE', 'FOLDER']),
  path: z
    .string()
    .min(1)
    .refine(
      (path) => !path.includes('\0') && isAbsolute(path),
      'La ruta debe ser absoluta y válida.',
    ),
});

export function trustedWindow(
  getWindow: () => BrowserWindow | null,
  trustedUrl: string,
): BrowserWindow | null {
  const window = getWindow();
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    window.webContents.mainFrame.url !== trustedUrl
  )
    return null;
  return window;
}

export function requireTrustedSender(
  getWindow: () => BrowserWindow | null,
  trustedUrl: string,
  event: IpcMainInvokeEvent,
): BrowserWindow {
  const window = trustedWindow(getWindow, trustedUrl);
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('Origen IPC no autorizado.');
  }
  return window;
}

export async function existingScanTarget(
  value: unknown,
): Promise<z.infer<typeof scanTargetSchema>> {
  const target = scanTargetSchema.parse(value);
  const info = await lstat(target.path);
  if (target.kind === 'FILE' ? !info.isFile() : !info.isDirectory()) {
    throw new Error('La ruta no corresponde al tipo de destino solicitado.');
  }
  return target;
}

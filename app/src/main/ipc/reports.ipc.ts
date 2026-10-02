import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { REPORTS_EXPORT, type ReportExportResult } from '../../shared/ipc';
import type { ReportBuilder } from '../../core/reports/ReportBuilder';
import { serializeReport } from '../../core/reports/exporters';
import { requireTrustedSender } from './scan-validation';

export const reportExportSchema = z.strictObject({
  reportDraftId: z.string().uuid(),
  format: z.enum(['html', 'csv', 'json']),
});
const argsSchema = z.tuple([reportExportSchema]);

export function registerReportsIpc(
  getWindow: () => BrowserWindow | null,
  trustedUrl: string,
  reports: ReportBuilder,
): () => void {
  let active = true;
  const validate = (event: IpcMainInvokeEvent) => {
    if (!active) throw new Error('Cerrado.');
    return requireTrustedSender(getWindow, trustedUrl, event);
  };
  ipcMain.handle(
    REPORTS_EXPORT,
    async (event, ...args: unknown[]): Promise<ReportExportResult> => {
      try {
        const window = validate(event);
        const [query] = argsSchema.parse(args);
        // La copia se toma antes del diálogo: caducidad/expulsión posterior no cambia
        // el reporte que el usuario está confirmando ni requiere otra consulta a la BD.
        const content = serializeReport(
          reports.get(query.reportDraftId),
          query.format,
        );
        const selected = await dialog.showSaveDialog(window, {
          title: 'Guardar reporte de CyberSOC',
          defaultPath: `reporte-${query.reportDraftId}.${query.format}`,
          filters: [
            { name: query.format.toUpperCase(), extensions: [query.format] },
          ],
          properties: ['showOverwriteConfirmation'],
        });
        validate(event);
        if (selected.canceled) return { status: 'CANCELLED' };
        if (
          !selected.filePath ||
          !isAbsolute(selected.filePath) ||
          selected.filePath.includes('\0')
        )
          throw new Error('Destino inválido.');
        // Único punto de escritura: exclusivamente la ruta aceptada en el diálogo nativo.
        await writeFile(selected.filePath, content, 'utf8');
        return { status: 'SAVED' };
      } catch {
        throw new Error(
          'No se pudo exportar el reporte. Vuelve a generarlo o elige otro destino.',
        );
      }
    },
  );
  return () => {
    active = false;
    ipcMain.removeHandler(REPORTS_EXPORT);
  };
}

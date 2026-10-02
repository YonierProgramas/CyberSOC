import type { ReportDraft } from '../ReportBuilder';
import { exportHtml } from './html';
import { exportCsv } from './csv';
import { exportJson } from './json';
export function serializeReport(
  draft: ReportDraft,
  format: 'html' | 'csv' | 'json',
): string {
  switch (format) {
    case 'html':
      return exportHtml(draft);
    case 'csv':
      return exportCsv(draft);
    case 'json':
      return exportJson(draft);
  }
}

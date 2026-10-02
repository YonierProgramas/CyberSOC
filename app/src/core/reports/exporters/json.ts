import type { ReportDraft } from '../ReportBuilder';
export function exportJson(draft: ReportDraft): string {
  return JSON.stringify(draft, null, 2) + '\n';
}

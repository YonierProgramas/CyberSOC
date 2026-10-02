import {
  reportFiltersSchema,
  type ReportBuilder,
} from '../../reports/ReportBuilder';
import type { ToolRegistry } from './ToolRegistry';
export function registerBuildReport(
  registry: ToolRegistry,
  reports: ReportBuilder,
): void {
  registry.register({
    name: 'build_report',
    description:
      'Calcula un borrador desde SQLite. No guarda archivos; exportar requiere confirmación del usuario.',
    arguments: reportFiltersSchema,
    execute: (filters) => {
      const draft = reports.build(filters);
      return {
        reportDraftId: draft.reportDraftId,
        filters: draft.filters,
        total: draft.total,
        verdicts: draft.verdicts,
        zones: draft.zones,
        results: draft.results,
        note: 'El borrador completo permanece en memoria para su exportación.',
      };
    },
  });
}

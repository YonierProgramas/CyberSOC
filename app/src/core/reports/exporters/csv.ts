import type { ReportDraft } from '../ReportBuilder';

/** RFC 4180: comillas dobles duplicadas y CRLF; neutraliza fórmulas de hojas de cálculo. */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportCsv(draft: ReportDraft): string {
  // Un CSV rectangular conserva todas las secciones sin mezclar cabeceras de tablas:
  // cada fila identifica sección, registro, campo y valor. Los índices comienzan en 1.
  const rows: unknown[][] = [['section', 'record', 'field', 'value']];
  const sections = {
    metadata: [
      {
        reportDraftId: draft.reportDraftId,
        createdAt: draft.createdAt,
        total: draft.total,
        filters: JSON.stringify(draft.filters),
      },
    ],
    jobs: draft.jobs,
    verdicts: draft.verdicts,
    zones: draft.zones,
    results: draft.results,
    evidence: draft.evidence,
    layers: draft.layers,
    assessments: draft.assessments,
    aiSummaries: draft.aiSummaries,
    aiNarrative: draft.aiNarrative ? [draft.aiNarrative] : [],
  };
  for (const [section, records] of Object.entries(sections))
    records.forEach((record, i) => {
      for (const [field, value] of Object.entries(record))
        rows.push([
          section,
          i + 1,
          field,
          Array.isArray(value) ? JSON.stringify(value) : value,
        ]);
    });
  return (
    '\ufeff' +
    rows.map((row) => row.map(csvCell).join(',')).join('\r\n') +
    '\r\n'
  );
}

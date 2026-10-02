import type { ReportDraft, ReportRow } from '../ReportBuilder';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}
function table(title: string, rows: ReportRow[]): string {
  if (rows.length === 0)
    return `<h2>${escapeHtml(title)}</h2><p>Sin datos.</p>`;
  const columns = Object.keys(rows[0]!);
  return `<h2>${escapeHtml(title)}</h2><table><thead><tr>${columns.map((key) => `<th>${escapeHtml(key)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((key) => `<td>${escapeHtml(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function exportHtml(draft: ReportDraft): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Reporte CyberSOC</title>
<style>body{font:15px system-ui,sans-serif;margin:2rem;color:#14243a;background:#fff}h1,h2{color:#103c64}table{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:2rem}th,td{border:1px solid #cad5df;padding:.5rem;text-align:left;overflow-wrap:anywhere}th{background:#edf3f8}p{white-space:pre-wrap}.ai{border-left:4px solid #7752b5;padding:1rem;background:#f5f1fa}</style></head><body>
<h1>Reporte de CyberSOC Defender</h1><p>Borrador: ${escapeHtml(draft.reportDraftId)}<br>Creado: ${escapeHtml(draft.createdAt)}<br>Resultados: ${escapeHtml(draft.total)}</p>
<p>Filtros: ${escapeHtml(JSON.stringify(draft.filters))}</p>
${table('Conteos por veredicto', draft.verdicts)}${table('Conteos por zona', draft.zones)}${table('Escaneos y versiones', draft.jobs)}${table('Resultados', draft.results)}${table('Evidencias', draft.evidence)}${table('Capas aplicadas', draft.layers)}${table('Decisiones y versión de RiskPolicy', draft.assessments)}
<section class="ai"><h2>Generado por IA</h2><p>Texto explicativo. Los conteos y tablas anteriores provienen de SQLite. Los resúmenes JOB_SUMMARY describen el escaneo completo, aunque el reporte use filtros.</p>
${table('Resúmenes de IA guardados', draft.aiSummaries)}${draft.aiNarrative ? `<h3>Resumen ejecutivo</h3><p>${escapeHtml(draft.aiNarrative.executiveSummary)}</p><h3>Conclusiones</h3><ul>${draft.aiNarrative.conclusions.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul><p>Resultados citados: ${escapeHtml(draft.aiNarrative.citedResultIds.join(', '))}</p>` : ''}</section></body></html>`;
}

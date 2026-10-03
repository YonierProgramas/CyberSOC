import { useState } from 'react';
import type {
  AssistantReportCardDTO,
  ReportExportQuery,
} from '../../../shared/ipc';
import { verdictLabel } from '../scan/format';
import { PlainText } from './PlainText';
import { ReferenceChips } from './ReferenceChips';

const formats = ['html', 'csv', 'json'] as const;

function verdictText(verdict: string): string {
  if (
    verdict === 'CLEAN' ||
    verdict === 'SUSPICIOUS' ||
    verdict === 'DETECTED' ||
    verdict === 'NOT_ANALYZED' ||
    verdict === 'NOT_EVALUATED'
  ) {
    return verdictLabel(verdict);
  }
  return verdict;
}

export function ReportCard({ report }: { report: AssistantReportCardDTO }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function exportAs(format: ReportExportQuery['format']) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.cybersoc.reports.export({
        reportDraftId: report.reportDraftId,
        format,
      });
      setNotice(
        result.status === 'SAVED'
          ? 'El reporte se guardó.'
          : 'Exportación cancelada.',
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'No se pudo exportar el reporte.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="copilot-card" data-testid="copilot-report">
      <h3>Reporte</h3>
      <p className="eyebrow">{report.label}</p>
      <div data-testid="copilot-report-summary">
        <PlainText text={report.executiveSummary} />
      </div>
      <div data-testid="copilot-report-conclusions">
        {report.conclusions.map((conclusion, index) => (
          <div key={index} data-testid="copilot-report-conclusion">
            <p className="eyebrow">{report.label}</p>
            <PlainText text={conclusion} />
          </div>
        ))}
      </div>
      <table data-testid="copilot-report-figures">
        <caption>Cifras del Core</caption>
        <tbody>
          <tr>
            <th>Total</th>
            <td>{report.total}</td>
          </tr>
          {report.verdicts.map((row) => (
            <tr key={row.verdict}>
              <th>{verdictText(row.verdict)}</th>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ReferenceChips
        references={report.citedResultIds.map((id) => ({
          type: 'result' as const,
          id,
        }))}
      />
      <div className="actions">
        {formats.map((format) => (
          <button
            key={format}
            type="button"
            data-testid={`copilot-export-${format}`}
            disabled={busy}
            onClick={() => void exportAs(format)}
          >
            Exportar {format.toUpperCase()}
          </button>
        ))}
      </div>
      {notice && (
        <p role="alert" data-testid="copilot-export-notice">
          {notice}
        </p>
      )}
    </section>
  );
}

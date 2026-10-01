import { useEffect, useState } from 'react';
import type { JobSummaryView } from '../../../shared/ipc';
import { PlainText } from './PlainText';

export function JobSummaryCard({
  jobId,
  refreshToken = 0,
  onOpenResult,
}: {
  jobId: string;
  refreshToken?: number;
  onOpenResult: (resultId: string) => void;
}) {
  const [summary, setSummary] = useState<JobSummaryView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void window.cybersoc.scan
      .getJobSummary(jobId)
      .then((value) => {
        if (active) setSummary(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [jobId, refreshToken]);

  const stateLabel =
    summary?.state === 'COMPLETED'
      ? 'Completo'
      : summary?.state === 'INVALID'
        ? 'Inválido'
        : summary?.state === 'UNAVAILABLE'
          ? 'No disponible'
          : 'Pendiente';

  return (
    <section className="panel" data-testid="job-summary">
      <h2>Resumen del escaneo</h2>
      {failed && <p role="alert">No se pudo cargar el resumen.</p>}
      <p>Estado de IA: {summary ? stateLabel : 'Consultando…'}</p>
      {summary?.state === 'PENDING' && <p>Análisis inteligente pendiente</p>}
      {summary?.state === 'UNAVAILABLE' && (
        <p>IA temporalmente no disponible</p>
      )}
      {summary?.state === 'INVALID' && (
        <p>Análisis descartado (respuesta inválida)</p>
      )}
      {summary?.state === 'COMPLETED' && summary.summary && (
        <>
          <PlainText text={summary.summary} />
          <h3>Resultados destacados</h3>
          {summary.highlights.length === 0 ? (
            <p>Sin destacados.</p>
          ) : (
            <ul className="job-list">
              {summary.highlights.map((item) => (
                <li key={item.resultId}>
                  <button
                    type="button"
                    data-testid="job-summary-highlight"
                    data-result-id={item.resultId}
                    onClick={() => onOpenResult(item.resultId)}
                  >
                    {item.resultId}
                  </button>
                  <PlainText text={item.why} />
                </li>
              ))}
            </ul>
          )}
          {summary.recommendations.length > 0 && (
            <>
              <h3>Recomendaciones</h3>
              {summary.recommendations.map((item) => (
                <PlainText key={item} text={item} />
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}

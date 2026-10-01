import { useEffect, useState } from 'react';
import type { ResultDetailDTO } from '../../../shared/ipc';
import {
  actionLabel,
  aiStatusLabel,
  aiStatusMessage,
  formatContextJson,
  formatDuration,
  severityLabel,
  verdictLabel,
} from '../scan/format';
import { PlainText } from './PlainText';

export function ResultDetail({ resultId }: { resultId: string }) {
  const [detail, setDetail] = useState<ResultDetailDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setFailed(false);
    const load = () => {
      void window.cybersoc.scan
        .getResult(resultId)
        .then((value) => {
          if (active) setDetail(value);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    };
    load();
    const stop = window.cybersoc.scan.onResultUpdated((update) => {
      if (update.resultId === resultId) load();
    });
    return () => {
      active = false;
      stop();
    };
  }, [resultId]);

  async function analyze() {
    setAsking(true);
    setAskError(null);
    try {
      await window.cybersoc.scan.analyzeNow(resultId);
    } catch (error) {
      setAskError(
        error instanceof Error
          ? error.message
          : 'No se pudo solicitar el análisis.',
      );
    } finally {
      setAsking(false);
    }
  }

  if (failed) return <p role="alert">No se pudo abrir el resultado.</p>;
  if (!detail) return <p>Cargando detalle…</p>;

  const { result, evidence, layers, analysis, sent } = detail;
  const statusMessage =
    sent?.validationStatus === 'UNSAFE'
      ? 'Análisis descartado por seguridad'
      : aiStatusMessage(result.aiStatus);

  return (
    <div data-testid="result-detail" className="result-detail">
      <section data-testid="result-summary" className="panel">
        <h2>Detalle del resultado</h2>
        <p>{result.fileName}</p>
        <dl className="counters">
          <div>
            <dt>Veredicto</dt>
            <dd>{verdictLabel(result.verdict)}</dd>
          </div>
          <div>
            <dt>Puntuación</dt>
            <dd>{result.engineScore ?? '—'}</dd>
          </div>
          <div>
            <dt>Nivel</dt>
            <dd>{result.riskLevel ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="panel" data-testid="evidence-panel">
        <h2>Evidencias</h2>
        {evidence.length === 0 ? (
          <p>Sin evidencias.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Capa</th>
                <th>Código</th>
                <th>Severidad</th>
                <th>Puntos</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((item) => (
                <tr key={item.id}>
                  <td>{item.source}</td>
                  <td>{item.code}</td>
                  <td>{severityLabel(item.severity)}</td>
                  <td>{item.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="layers-applied">
        <h2>Capas aplicadas</h2>
        {layers.length === 0 ? (
          <p>Sin traza de capas.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Capa</th>
                <th>Estado</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((layer) => (
                <tr key={layer.layer}>
                  <td>{layer.layer}</td>
                  <td>{layer.status}</td>
                  <td>
                    {layer.status === 'SKIPPED' || layer.status === 'ERROR'
                      ? (layer.reason ?? '—')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="ai-analysis">
        <h2>Análisis inteligente</h2>
        <p>
          Estado de IA: {aiStatusLabel(result.aiStatus)}
          {statusMessage ? ` — ${statusMessage}` : ''}
        </p>
        <button
          type="button"
          data-testid="analyze-with-ai"
          disabled={asking}
          onClick={() => void analyze()}
        >
          Analizar con IA
        </button>
        {askError && <p role="alert">{askError}</p>}
        {analysis && (
          <>
            <h3>Resumen</h3>
            <PlainText text={analysis.summary} />
            <h3>Explicación sencilla</h3>
            <PlainText text={analysis.plainExplanation} />
            <h3>Análisis técnico</h3>
            <PlainText text={analysis.technicalAnalysis} />
            <h3>Correlaciones</h3>
            {analysis.correlations.length === 0 ? (
              <p>Sin correlaciones.</p>
            ) : (
              analysis.correlations.map((item) => (
                <div key={item.insight} className="correlation">
                  <div className="chips">
                    {item.evidenceIds.map((id) => (
                      <span key={id} className="chip">
                        {id}
                      </span>
                    ))}
                  </div>
                  <PlainText text={item.insight} />
                </div>
              ))
            )}
            <h3>Recomendación</h3>
            <PlainText
              text={`${actionLabel(analysis.recommendedAction)}. ${analysis.actionRationale}`}
            />
          </>
        )}
      </section>

      <section className="panel" data-testid="ai-sent">
        <h2>Qué se envió a la IA</h2>
        {sent ? (
          <>
            <dl className="counters">
              <div>
                <dt>Modelo</dt>
                <dd>{sent.model ?? '—'}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>
                  {sent.inputTokens ?? '—'} entrada · {sent.outputTokens ?? '—'}{' '}
                  salida
                </dd>
              </div>
              <div>
                <dt>Latencia</dt>
                <dd>{formatDuration(sent.latencyMs)}</dd>
              </div>
            </dl>
            <pre className="context-json">
              {formatContextJson(sent.contextJson)}
            </pre>
          </>
        ) : (
          <p>Todavía no se ha enviado este resultado a la IA.</p>
        )}
      </section>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ResultDetailDTO } from '../../../shared/ipc';
import {
  actionLabel,
  aiStatusLabel,
  aiStatusMessage,
  appliedCaps,
  formatContextJson,
  formatDuration,
  layerStatusLabel,
  policyRuleLabel,
  profileLabel,
  severityLabel,
  verdictLabel,
  zoneLabel,
} from '../scan/format';
import { PlainText } from './PlainText';
import { QuarantineButton } from './QuarantineButton';

export function ResultDetail({
  resultId,
  profileJson = null,
}: {
  resultId: string;
  profileJson?: string | null;
}) {
  const [detail, setDetail] = useState<ResultDetailDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

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
  }, [resultId, revision]);

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

  const { result, evidence, layers, decision, analysis, sent } = detail;
  const caps = appliedCaps(evidence);
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
          <div>
            <dt>Zona</dt>
            <dd data-testid="result-zone">{zoneLabel(result.zone)}</dd>
          </div>
          <div>
            <dt>Perfil</dt>
            <dd data-testid="result-profile">
              {profileLabel(profileJson, result.zone)}
            </dd>
          </div>
        </dl>
        {decision?.origin === 'AI_ESCALATION' && (
          <p data-testid="ai-escalation">Escalado por IA</p>
        )}
        <QuarantineButton
          resultId={result.id}
          path={result.path}
          verdict={result.verdict}
          onDone={() => setRevision((value) => value + 1)}
        />
      </section>

      <section className="panel" data-testid="decision-panel">
        <h2>¿Cómo se decidió?</h2>
        {evidence.length === 0 ? (
          <p>Sin evidencias en la decisión.</p>
        ) : (
          <table data-testid="decision-evidence">
            <thead>
              <tr>
                <th>Evidencia</th>
                <th>Capa</th>
                <th>Puntos</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((item) => (
                <tr key={item.id}>
                  <td>{item.code}</td>
                  <td>{item.source}</td>
                  <td>{item.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>Topes aplicados</h3>
        <ul data-testid="decision-caps">
          <li>
            Heurísticas (FILETYPE, HEURISTICS, PE, SCRIPTS):{' '}
            {caps.heuristicsRaw} puntos, tope 50, aplicados{' '}
            {caps.heuristicsCapped}
          </li>
          <li>
            Reglas: {caps.rulesRaw} puntos, tope 60, aplicados{' '}
            {caps.rulesCapped}
          </li>
          <li>Otras capas: {caps.otherPoints} puntos</li>
          <li>Total con tope 100: {caps.totalCapped}</li>
        </ul>
        <p data-testid="decision-rule">
          Regla de la política: {policyRuleLabel(decision?.rule ?? null)}
        </p>
        <p data-testid="policy-version">
          Versión de la política: {decision?.policyVersion ?? '—'}
        </p>
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
                  <td data-testid={`layer-status-${layer.layer}`}>
                    {layerStatusLabel(layer.status, layer.reason)}
                  </td>
                  <td>
                    {layer.status === 'DISABLED'
                      ? 'desactivada por el perfil'
                      : layer.status === 'SKIPPED' || layer.status === 'ERROR'
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

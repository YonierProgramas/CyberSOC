import { useEffect, useState } from 'react';
import type { QuarantineItemDTO, ScanResultDTO } from '../../../shared/ipc';
import { useShell } from '../navigation/shell';
import {
  MAX_SECURITY_ALERTS,
  quarantineNotice,
  updateAlerts,
  watchSecurityAlerts,
} from '../security/alerts';
import { QuarantineButton } from './QuarantineButton';

export function SecurityAlerts() {
  const [results, setResults] = useState<ScanResultDTO[]>([]);
  const [items, setItems] = useState<QuarantineItemDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { openReference, setView } = useShell();

  useEffect(
    () =>
      watchSecurityAlerts(
        window.cybersoc.scan,
        (incoming) => {
          setResults((current) => updateAlerts(current, incoming));
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  useEffect(() => {
    let active = true;
    let revision = 0;
    async function load() {
      const ownRevision = ++revision;
      try {
        const current = await window.cybersoc.quarantine.list();
        if (active && ownRevision === revision) setItems(current);
      } catch {
        if (active && ownRevision === revision) setItems(null);
      }
    }
    const stop = window.cybersoc.quarantine.onChanged(() => void load());
    void load();
    return () => {
      active = false;
      stop();
    };
  }, []);

  if (!results.length && !failed) return null;

  function renderAlert(result: ScanResultDTO) {
    const notice = quarantineNotice(result, items);
    return (
      <article key={result.id} data-testid="security-alert-file">
        <p>
          <strong>
            {result.verdict === 'DETECTED'
              ? 'Archivo detectado'
              : 'Archivo sospechoso'}
            : {result.fileName}
          </strong>
        </p>
        <p className="path" title={result.path}>
          {result.path}
        </p>
        <p
          data-testid="security-quarantine-status"
          className={notice.isolated ? 'security-isolated' : ''}
        >
          {notice.text}
        </p>
        <div className="actions">
          {notice.canQuarantine && (
            <QuarantineButton
              resultId={result.id}
              path={result.path}
              verdict={result.verdict}
              buttonTestId="security-quarantine-file"
              onDone={() => undefined}
            />
          )}
          <button
            type="button"
            onClick={() => openReference({ type: 'result', id: result.id })}
          >
            Ver detalle
          </button>
          <button type="button" onClick={() => setView('quarantine')}>
            Abrir cuarentena
          </button>
        </div>
      </article>
    );
  }

  return (
    <section
      className="security-alerts"
      data-testid="security-alerts"
      aria-label="Alertas de seguridad"
    >
      <div role="alert" aria-atomic="true">
        <h2>Atención: se encontraron archivos que requieren revisión</h2>
        {failed && (
          <p>
            No se pudieron actualizar todos los avisos. Revisa el historial del
            análisis.
          </p>
        )}
        {results[0] && renderAlert(results[0])}
      </div>
      {results.length > 1 && (
        <details>
          <summary>Ver otros avisos ({results.length - 1})</summary>
          <div className="security-alert-list">
            {results.slice(1).map(renderAlert)}
          </div>
        </details>
      )}
      {results.length === MAX_SECURITY_ALERTS && (
        <p>
          Se muestran los últimos {MAX_SECURITY_ALERTS} avisos. Consulta el
          historial para ver todos los resultados.
        </p>
      )}
    </section>
  );
}

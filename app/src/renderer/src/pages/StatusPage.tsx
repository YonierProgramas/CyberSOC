import { useEffect, useRef, useState } from 'react';
import type { DashboardOverviewDTO, SystemStatus } from '../../../shared/ipc';
import { PageHeader, StatusBadge } from '../components/ui';
import { fileNameOf, jobStatusLabel } from '../scan/format';
import { publishEngineStatus } from '../system/engineStatus';

export function StatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [overview, setOverview] = useState<DashboardOverviewDTO | null>(null);
  const [overviewState, setOverviewState] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  const [aiLabel, setAiLabel] = useState('Sin confirmar');
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const current = generation.current;
      try {
        const value = await window.cybersoc.system.getStatus();
        if (active && current === generation.current) {
          setStatus(value);
          setFailed(false);
          publishEngineStatus(value, false);
        }
      } catch {
        if (active && current === generation.current) {
          setFailed(true);
          publishEngineStatus(null, true);
        }
      } finally {
        pending = false;
      }
    };
    void refresh();
    void window.cybersoc.dashboard
      .getOverview()
      .then((value) => {
        if (!active) return;
        setOverview(value);
        setOverviewState('ready');
      })
      .catch(() => {
        if (!active) return;
        setOverviewState('error');
      });
    void window.cybersoc.settings.ai
      .getStatus()
      .then((value) => {
        if (!active) return;
        setAiLabel(
          value.configured
            ? `Clave configurada · modelo ${value.model}`
            : 'Sin configurar',
        );
      })
      .catch(() => {
        if (active) setAiLabel('No se pudo consultar');
      });
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function reconnect() {
    generation.current += 1;
    setReconnecting(true);
    try {
      const value = await window.cybersoc.system.reconnectEngine();
      setStatus(value);
      publishEngineStatus(value, false);
      setFailed(false);
    } catch {
      setFailed(true);
      publishEngineStatus(null, true);
    } finally {
      generation.current += 1;
      setReconnecting(false);
    }
  }

  const engine = status?.engine;
  const engineText = !status
    ? 'Consultando estado…'
    : engine?.status === 'connected'
      ? `Motor: conectado v${engine.engineVersion} · protocolo ${engine.protocol}`
      : engine?.status === 'incompatible'
        ? `Motor: incompatible${engine.protocol ? ` · protocolo ${engine.protocol}` : ''}`
        : 'Motor: desconectado';
  const platform = navigator.userAgent.includes('Windows')
    ? 'Windows'
    : navigator.platform || 'Plataforma no identificada';
  const lastJob = overview?.distributions.lastCompleted?.job;
  return (
    <main className="narrow">
      <PageHeader
        eyebrow="Diagnóstico"
        title={status?.app ?? 'CyberSOC Defender'}
        description="Solo se muestra lo que esta pantalla pudo consultar. Un componente sin respuesta no se marca como operativo."
      />
      {failed && <p role="alert">No se pudo consultar el estado del motor.</p>}
      <div className="card-grid">
        <section className="settings-card">
          <h2>Motor antivirus</h2>
          <p data-testid="engine-status" role="status">
            {engineText}
          </p>
          {engine?.status === 'connected' && (
            <StatusBadge tone="good">Responde</StatusBadge>
          )}
          {engine?.status === 'disconnected' && (
            <StatusBadge tone="warn">Sin conexión</StatusBadge>
          )}
          {engine?.status === 'incompatible' && (
            <StatusBadge tone="bad">Protocolo incompatible</StatusBadge>
          )}
          <div className="actions">
            <button
              type="button"
              disabled={reconnecting}
              onClick={() => void reconnect()}
            >
              {reconnecting ? 'Reconectando…' : 'Reconectar'}
            </button>
          </div>
        </section>
        <section className="settings-card">
          <h2>Aplicación</h2>
          <p>Versión {status ? status.version : 'sin confirmar'}</p>
          <p>Plataforma detectada: {platform}</p>
        </section>
        <section className="settings-card">
          <h2>Componentes</h2>
          <ul>
            <li>
              Motor Python:{' '}
              {engine?.status === 'connected'
                ? 'la consulta de estado respondió conectado'
                : engine
                  ? engineText
                  : 'sin confirmar'}
            </li>
            <li>
              Comunicación con Electron:{' '}
              {failed
                ? 'la consulta de estado no respondió'
                : status
                  ? 'la consulta de estado respondió'
                  : 'sin confirmar'}
            </li>
            <li>
              Base de datos local: sin comprobación directa en esta pantalla.
            </li>
            <li>Proveedor de IA: {aiLabel}. No se probó la conexión.</li>
          </ul>
        </section>
        <section className="settings-card">
          <h2>Información operativa</h2>
          <p>Última conexión: esta pantalla no recibe esa hora.</p>
          <p>
            Último análisis:{' '}
            {overviewState === 'loading'
              ? 'consultando…'
              : overviewState === 'error'
                ? 'no se pudo consultar el resumen'
                : lastJob
                  ? `${fileNameOf(lastJob.targetPath)} · ${jobStatusLabel(lastJob.status)}`
                  : 'sin análisis completado'}
          </p>
          <p>
            Operación activa:{' '}
            {overview?.active
              ? `${fileNameOf(overview.active.targetPath)} · ${jobStatusLabel(overview.active.status)}`
              : overviewState === 'ready'
                ? 'no hay un análisis en curso en el registro'
                : 'sin confirmar'}
          </p>
        </section>
      </div>
    </main>
  );
}

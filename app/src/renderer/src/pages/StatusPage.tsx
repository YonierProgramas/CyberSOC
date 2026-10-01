import { useEffect, useRef, useState } from 'react';
import type { SystemStatus } from '../../../shared/ipc';

export function StatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
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
        }
      } catch {
        if (active && current === generation.current) setFailed(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
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
      setStatus(await window.cybersoc.system.reconnectEngine());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      generation.current += 1;
      setReconnecting(false);
    }
  }

  const engine = status?.engine;
  return (
    <main className="narrow">
      <p className="eyebrow">Estado de la aplicación</p>
      <h1>{status?.app ?? 'CyberSOC Defender'}</h1>
      {status && <p>Versión {status.version}</p>}
      {failed && <p role="alert">No se pudo consultar el estado del motor.</p>}
      <p data-testid="engine-status" role="status">
        {!status
          ? 'Consultando estado…'
          : engine?.status === 'connected'
            ? `Motor: conectado v${engine.engineVersion} · protocolo ${engine.protocol}`
            : engine?.status === 'incompatible'
              ? `Motor: incompatible${engine.protocol ? ` · protocolo ${engine.protocol}` : ''}`
              : 'Motor: desconectado'}
      </p>
      <button
        type="button"
        disabled={reconnecting}
        onClick={() => void reconnect()}
      >
        {reconnecting ? 'Reconectando…' : 'Reconectar'}
      </button>
    </main>
  );
}

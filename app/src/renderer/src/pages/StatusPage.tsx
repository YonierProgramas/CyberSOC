import { useEffect, useState } from 'react';
import type { SystemStatus } from '../../../shared/ipc';

export function StatusPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    window.cybersoc.system.getStatus().then(
      (value) => {
        if (active) setStatus(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <p className="eyebrow">Estado de la aplicación</p>
      <h1>{status?.app ?? 'CyberSOC Defender'}</h1>
      {failed ? (
        <p role="alert">
          No se pudo consultar el estado. Cierra y vuelve a abrir la aplicación.
        </p>
      ) : status ? (
        <p role="status">Versión {status.version}</p>
      ) : (
        <p role="status">Consultando estado…</p>
      )}
    </main>
  );
}

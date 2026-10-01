import { useEffect, useState } from 'react';
import type { AIHealthCheck, AISettingsStatus } from '../../../shared/ipc';

export function SettingsPage() {
  const [status, setStatus] = useState<AISettingsStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function refresh() {
    setStatus(await window.cybersoc.settings.ai.getStatus());
  }

  useEffect(() => {
    let active = true;
    void window.cybersoc.settings.ai
      .getStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      await window.cybersoc.settings.ai.setApiKey(key);
      setKey('');
      await refresh();
      setMessage('Clave guardada.');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const result: AIHealthCheck =
        await window.cybersoc.settings.ai.testConnection();
      setMessage(
        result.ok
          ? `Conexión correcta con ${result.model}.`
          : result.error.message,
      );
      if (!result.ok) setFailed(true);
    } catch {
      setFailed(true);
      setMessage('No se pudo probar la conexión.');
    } finally {
      setBusy(false);
    }
  }

  const configured =
    status?.configured && status.last4
      ? `Configurada ••••${status.last4}`
      : 'Sin configurar';

  return (
    <main className="narrow">
      <p className="eyebrow">Configuración</p>
      <h1>API de Claude</h1>
      <section className="panel" data-testid="ai-settings">
        <p>{status ? configured : 'Consultando…'}</p>
        {status?.model && <p>Modelo: {status.model}</p>}
        <label>
          API key
          <input
            data-testid="api-key-input"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            disabled={busy || key.trim() === ''}
            data-testid="save-api-key"
            onClick={() => void save()}
          >
            Guardar
          </button>
          <button
            type="button"
            data-testid="test-ai-connection"
            disabled={busy}
            onClick={() => void testConnection()}
          >
            Probar conexión
          </button>
        </div>
        {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
        {failed && !message && (
          <p role="alert">No se pudo guardar la configuración.</p>
        )}
      </section>
    </main>
  );
}

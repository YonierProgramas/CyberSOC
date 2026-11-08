import { useEffect, useState } from 'react';
import type { AIHealthCheck, AISettingsStatus } from '../../../shared/ipc';
import { PageHeader } from '../components/ui';
import { engineHeadline, useEngineStatus } from '../system/engineStatus';
import { useTheme } from '../theme/theme';

export function SettingsPage() {
  const engine = useEngineStatus();
  const { theme, reducedMotion, setTheme, setReducedMotion } = useTheme();
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
      <PageHeader
        eyebrow="Configuración"
        title="Ajustes locales"
        description="La clave de Claude sigue en el almacén seguro del sistema. Esta pantalla no la muestra completa ni la guarda en el navegador."
      />
      <section className="settings-card" data-testid="ai-settings">
        <h2>Asistente de inteligencia artificial</h2>
        <p>{status ? configured : 'Consultando…'}</p>
        {status?.model && <p>Modelo: {status.model}</p>}
        <p className="hint">
          El campo es de contraseña. Guardar usa el almacenamiento ya existente.
          Probar conexión llama a Claude y puede consumir crédito; no se ejecuta
          sola.
        </p>
        <label>
          API key
          <input
            data-testid="api-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="primary"
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
      <section className="settings-card">
        <h2>Información del sistema</h2>
        <p>
          Versión {engine.status?.version ?? 'sin confirmar'} ·{' '}
          {engineHeadline(engine)}
        </p>
      </section>
      <section className="settings-card">
        <h2>Preferencias visuales</h2>
        <div className="actions" role="group" aria-label="Tema">
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
          >
            Oscuro
          </button>
          <button
            type="button"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
          >
            Claro
          </button>
        </div>
        <label>
          <span>Reducir animaciones</span>
          <input
            type="checkbox"
            checked={reducedMotion}
            onChange={(event) => setReducedMotion(event.target.checked)}
          />
        </label>
        <p className="hint">
          El tema y el movimiento se guardan solo en este equipo, dentro del
          renderer. No cambian el motor ni la clave.
        </p>
      </section>
    </main>
  );
}

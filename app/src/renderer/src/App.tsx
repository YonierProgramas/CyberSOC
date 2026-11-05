import { CopilotPanel } from './components/CopilotPanel';
import { useAssistantChrome } from './components/AssistantDock';
import { CopilotFocusProvider } from './copilot/focus';
import { ShellProvider, useShell } from './navigation/shell';
import { DashboardPage } from './pages/DashboardPage';
import { HistoryPage } from './pages/HistoryPage';
import { QuarantinePage } from './pages/QuarantinePage';
import { ScanPage } from './pages/ScanPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatusPage } from './pages/StatusPage';

export function App() {
  return (
    <CopilotFocusProvider>
      <ShellProvider>
        <AppFrame />
      </ShellProvider>
    </CopilotFocusProvider>
  );
}

function AppFrame() {
  const { view, setView } = useShell();
  const assistant = useAssistantChrome();
  const shellClass = assistant.open
    ? assistant.narrow
      ? 'app-shell assistant-modal'
      : 'app-shell assistant-open'
    : 'app-shell';
  return (
    <div className={shellClass}>
      <div className="app-main" ref={assistant.mainRef}>
        <nav className="nav">
          <button
            type="button"
            data-testid="nav-home"
            aria-current={view === 'home' ? 'page' : undefined}
            onClick={() => setView('home')}
          >
            Inicio
          </button>
          <button
            type="button"
            data-testid="nav-scan"
            aria-current={view === 'scan' ? 'page' : undefined}
            onClick={() => setView('scan')}
          >
            Escaneo
          </button>
          <button
            type="button"
            data-testid="nav-history"
            aria-current={view === 'history' ? 'page' : undefined}
            onClick={() => setView('history')}
          >
            Historial
          </button>
          <button
            type="button"
            data-testid="nav-quarantine"
            aria-current={view === 'quarantine' ? 'page' : undefined}
            onClick={() => setView('quarantine')}
          >
            Cuarentena
          </button>
          <button
            type="button"
            data-testid="nav-status"
            aria-current={view === 'status' ? 'page' : undefined}
            onClick={() => setView('status')}
          >
            Estado
          </button>
          <button
            type="button"
            data-testid="nav-settings"
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => setView('settings')}
          >
            Configuración
          </button>
          <button
            ref={assistant.opener}
            type="button"
            className="assistant-toggle"
            data-testid="assistant-open"
            aria-expanded={assistant.open}
            aria-controls="assistant-panel"
            onClick={assistant.openAssistant}
          >
            Asistente
          </button>
        </nav>
        {view === 'home' && <DashboardPage />}
        {view === 'scan' && <ScanPage />}
        {view === 'history' && <HistoryPage />}
        {view === 'quarantine' && <QuarantinePage />}
        {view === 'status' && <StatusPage />}
        {view === 'settings' && <SettingsPage />}
      </div>
      <div id="assistant-panel">
        <CopilotPanel
          open={assistant.open}
          narrow={assistant.narrow}
          onClose={assistant.close}
        />
      </div>
    </div>
  );
}

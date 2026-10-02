import { useState } from 'react';
import { CopilotPanel } from './components/CopilotPanel';
import { CopilotFocusProvider } from './copilot/focus';
import { HistoryPage } from './pages/HistoryPage';
import { ScanPage } from './pages/ScanPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatusPage } from './pages/StatusPage';

type View = 'scan' | 'history' | 'status' | 'settings';

export function App() {
  const [view, setView] = useState<View>('scan');
  return (
    <CopilotFocusProvider>
      <div className="app-shell">
        <div className="app-main">
          <nav className="nav">
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
          </nav>
          {view === 'scan' && <ScanPage />}
          {view === 'history' && <HistoryPage />}
          {view === 'status' && <StatusPage />}
          {view === 'settings' && <SettingsPage />}
        </div>
        <CopilotPanel />
      </div>
    </CopilotFocusProvider>
  );
}

import { useState } from 'react';
import { HistoryPage } from './pages/HistoryPage';
import { ScanPage } from './pages/ScanPage';
import { StatusPage } from './pages/StatusPage';

type View = 'scan' | 'history' | 'status';

export function App() {
  const [view, setView] = useState<View>('scan');
  return (
    <div className="app-shell">
      <nav className="nav">
        <button
          type="button"
          aria-current={view === 'scan' ? 'page' : undefined}
          onClick={() => setView('scan')}
        >
          Escaneo
        </button>
        <button
          type="button"
          aria-current={view === 'history' ? 'page' : undefined}
          onClick={() => setView('history')}
        >
          Historial
        </button>
        <button
          type="button"
          aria-current={view === 'status' ? 'page' : undefined}
          onClick={() => setView('status')}
        >
          Estado
        </button>
      </nav>
      {view === 'scan' && <ScanPage />}
      {view === 'history' && <HistoryPage />}
      {view === 'status' && <StatusPage />}
    </div>
  );
}

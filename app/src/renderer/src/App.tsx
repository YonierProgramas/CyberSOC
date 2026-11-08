import { useEffect, useState } from 'react';
import { CopilotPanel } from './components/CopilotPanel';
import { useAssistantChrome } from './components/AssistantDock';
import { Sidebar } from './components/Sidebar';
import { CopilotFocusProvider } from './copilot/focus';
import { ShellProvider, useShell } from './navigation/shell';
import { DashboardPage } from './pages/DashboardPage';
import { HistoryPage } from './pages/HistoryPage';
import { QuarantinePage } from './pages/QuarantinePage';
import { ScanPage } from './pages/ScanPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatusPage } from './pages/StatusPage';
import { useEngineStatus } from './system/engineStatus';
import { ThemeProvider } from './theme/theme';

const SIDEBAR_KEY = 'cybersoc-sidebar';

function readCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved === 'collapsed') return true;
    if (saved === 'expanded') return false;
  } catch {
    /* Sin preferencia guardada se usa el ancho de la ventana. */
  }
  return window.matchMedia('(max-width: 1100px)').matches;
}

export function App() {
  return (
    <ThemeProvider>
      <CopilotFocusProvider>
        <ShellProvider>
          <AppFrame />
        </ShellProvider>
      </CopilotFocusProvider>
    </ThemeProvider>
  );
}

function AppFrame() {
  const { view, setView } = useShell();
  const assistant = useAssistantChrome();
  const engine = useEngineStatus();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const onChange = () => {
      try {
        if (localStorage.getItem(SIDEBAR_KEY)) return;
      } catch {
        /* Sin almacén local, el ancho de la ventana manda. */
      }
      setCollapsed(media.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const shellClass = [
    'app-shell',
    assistant.open
      ? assistant.narrow
        ? 'assistant-modal'
        : 'assistant-open'
      : '',
    collapsed ? 'sidebar-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded');
      } catch {
        /* La preferencia del menú no afecta al motor. */
      }
      return next;
    });
  }

  return (
    <div className={shellClass}>
      <div className="app-main" ref={assistant.mainRef}>
        <div className="workspace">
          <Sidebar
            view={view}
            collapsed={collapsed}
            onToggle={toggleSidebar}
            onNavigate={setView}
            openerRef={assistant.opener}
            assistantOpen={assistant.open}
            onOpenAssistant={assistant.openAssistant}
            engine={engine}
          />
          <div className="workspace-content">
            {view === 'home' && <DashboardPage />}
            {view === 'scan' && <ScanPage />}
            {view === 'history' && <HistoryPage />}
            {view === 'quarantine' && <QuarantinePage />}
            {view === 'status' && <StatusPage />}
            {view === 'settings' && <SettingsPage />}
          </div>
        </div>
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

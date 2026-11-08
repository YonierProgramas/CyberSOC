import type { KeyboardEvent, RefObject } from 'react';
import type { AppView } from '../navigation/shell';
import {
  engineHeadline,
  engineTone,
  type EngineSnapshot,
} from '../system/engineStatus';
import {
  AssistantIcon,
  HistoryIcon,
  HomeIcon,
  PanelIcon,
  PulseIcon,
  ScanIcon,
  SettingsIcon,
  ShieldIcon,
  VaultIcon,
} from './icons';

const primary: {
  id: AppView;
  label: string;
  testId: string;
  icon: typeof HomeIcon;
}[] = [
  { id: 'home', label: 'Inicio', testId: 'nav-home', icon: HomeIcon },
  { id: 'scan', label: 'Escaneo', testId: 'nav-scan', icon: ScanIcon },
  {
    id: 'history',
    label: 'Historial',
    testId: 'nav-history',
    icon: HistoryIcon,
  },
  {
    id: 'quarantine',
    label: 'Cuarentena',
    testId: 'nav-quarantine',
    icon: VaultIcon,
  },
];

const system: {
  id: AppView;
  label: string;
  testId: string;
  icon: typeof HomeIcon;
}[] = [
  { id: 'status', label: 'Estado', testId: 'nav-status', icon: PulseIcon },
  {
    id: 'settings',
    label: 'Configuración',
    testId: 'nav-settings',
    icon: SettingsIcon,
  },
];

export function Sidebar({
  view,
  collapsed,
  onToggle,
  onNavigate,
  openerRef,
  assistantOpen,
  onOpenAssistant,
  engine,
}: {
  view: AppView;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (view: AppView) => void;
  openerRef: RefObject<HTMLButtonElement | null>;
  assistantOpen: boolean;
  onOpenAssistant: () => void;
  engine: EngineSnapshot;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  }

  const version = engine.status?.version;
  return (
    <aside className="sidebar" aria-label="Navegación principal">
      <div className="brand">
        <span className="brand-mark">
          <ShieldIcon />
        </span>
        <span className="brand-copy">
          <strong>CyberSOC Defender</strong>
          <span>
            {version ? `Versión ${version}` : 'Versión sin confirmar'}
          </span>
        </span>
        <button
          type="button"
          className="icon-button"
          aria-expanded={!collapsed}
          aria-controls="app-nav"
          data-testid="sidebar-collapse"
          title={collapsed ? 'Expandir menú' : 'Contraer menú'}
          onClick={onToggle}
        >
          <PanelIcon />
          <span className="nav-text">
            {collapsed ? 'Expandir menú' : 'Contraer menú'}
          </span>
        </button>
      </div>
      <nav id="app-nav" className="nav" onKeyDown={onKeyDown}>
        <p className="nav-group-label">Principal</p>
        {primary.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            current={view === item.id}
            onNavigate={onNavigate}
          />
        ))}
        <p className="nav-group-label">Sistema</p>
        {system.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            current={view === item.id}
            onNavigate={onNavigate}
          />
        ))}
        <p className="nav-group-label">Asistente</p>
        <button
          ref={openerRef}
          type="button"
          className="assistant-toggle"
          data-testid="assistant-open"
          aria-expanded={assistantOpen}
          aria-controls="assistant-panel"
          title="Asistente"
          onClick={onOpenAssistant}
        >
          <AssistantIcon />
          <span className="nav-text">Asistente</span>
        </button>
      </nav>
      <button
        type="button"
        className="sidebar-foot"
        data-testid="sidebar-engine"
        title={engineHeadline(engine)}
        onClick={() => onNavigate('status')}
      >
        <span className={`status-dot tone-${engineTone(engine)}`} />
        <span className="foot-copy">
          <strong>{engineHeadline(engine)}</strong>
          {engine.failed && <span>La última consulta falló.</span>}
          {!engine.failed && engine.status?.engine.status === 'connected' && (
            <span>Protocolo {engine.status.engine.protocol}</span>
          )}
        </span>
      </button>
    </aside>
  );
}

function NavButton({
  item,
  current,
  onNavigate,
}: {
  item: (typeof primary)[number];
  current: boolean;
  onNavigate: (view: AppView) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-testid={item.testId}
      aria-current={current ? 'page' : undefined}
      title={item.label}
      onClick={() => onNavigate(item.id)}
    >
      <Icon />
      <span className="nav-text">{item.label}</span>
    </button>
  );
}

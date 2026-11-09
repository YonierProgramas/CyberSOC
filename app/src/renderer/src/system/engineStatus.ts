import { useEffect, useState } from 'react';
import type { SystemStatus } from '../../../shared/ipc';

export interface EngineSnapshot {
  phase: 'loading' | 'ready' | 'error';
  status: SystemStatus | null;
  failed: boolean;
}

let snapshot: EngineSnapshot = {
  phase: 'loading',
  status: null,
  failed: false,
};
// Invariant: each subscriber appears only once. Add/remove in Set: expected
// O(1); notifying everyone walks the n subscribers and costs O(n).
const listeners = new Set<(value: EngineSnapshot) => void>();
let timer: number | null = null;
let refreshing = false;

function emit(next: EngineSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener(snapshot);
}

/** Publishes a real status query. It does not invent «operativo». */
export function publishEngineStatus(
  status: SystemStatus | null,
  failed: boolean,
) {
  if (status) {
    emit({ phase: 'ready', status, failed });
    return;
  }
  if (snapshot.status) {
    emit({ phase: 'ready', status: snapshot.status, failed: true });
    return;
  }
  emit({ phase: 'error', status: null, failed: true });
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await window.cybersoc.system.getStatus();
    publishEngineStatus(status, false);
  } catch {
    publishEngineStatus(null, true);
  } finally {
    refreshing = false;
  }
}

export function engineHeadline(value: EngineSnapshot): string {
  if (value.phase === 'loading') return 'Consultando el motor…';
  const engine = value.status?.engine;
  if (!engine) return 'Motor: no se pudo consultar';
  if (engine.status === 'connected') {
    return `Motor conectado · v${engine.engineVersion}`;
  }
  if (engine.status === 'incompatible') return 'Motor incompatible';
  return 'Motor desconectado';
}

export function engineTone(
  value: EngineSnapshot,
): 'neutral' | 'good' | 'warn' | 'bad' {
  const status = value.status?.engine.status;
  if (value.phase === 'loading' || !status) return 'neutral';
  if (status === 'connected') return 'good';
  if (status === 'incompatible') return 'bad';
  return 'warn';
}

export function useEngineStatus(): EngineSnapshot {
  const [value, setValue] = useState(snapshot);
  useEffect(() => {
    listeners.add(setValue);
    setValue(snapshot);
    if (listeners.size === 1) {
      void refresh();
      timer = window.setInterval(() => void refresh(), 2000);
    }
    return () => {
      listeners.delete(setValue);
      if (listeners.size === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return value;
}

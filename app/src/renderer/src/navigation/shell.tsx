import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AssistantReferenceDTO } from '../../../shared/ipc';

export type AppView = 'scan' | 'history' | 'quarantine' | 'status' | 'settings';

export type OpenRequest =
  | { nonce: number; kind: 'RESULT'; resultId: string }
  | { nonce: number; kind: 'JOB'; jobId: string }
  | { nonce: number; kind: 'RULE'; ruleId: string }
  | { nonce: number; kind: 'ZONE'; zoneId: string };

const ShellContext = createContext<{
  view: AppView;
  setView: (view: AppView) => void;
  request: OpenRequest | null;
  openReference: (reference: AssistantReferenceDTO) => void;
  watchJobId: string | null;
  watchScan: (jobId: string) => void;
} | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<AppView>('scan');
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [watchJobId, setWatchJobId] = useState<string | null>(null);
  const nonce = useRef(0);

  const openReference = useCallback((reference: AssistantReferenceDTO) => {
    const next = ++nonce.current;
    if (reference.type === 'result') {
      setView('history');
      setRequest({ nonce: next, kind: 'RESULT', resultId: reference.id });
    } else if (reference.type === 'job') {
      setView('history');
      setRequest({ nonce: next, kind: 'JOB', jobId: reference.id });
    } else if (reference.type === 'rule') {
      setView('history');
      setRequest({ nonce: next, kind: 'RULE', ruleId: reference.id });
    } else {
      setView('history');
      setRequest({ nonce: next, kind: 'ZONE', zoneId: reference.id });
    }
  }, []);

  const watchScan = useCallback((jobId: string) => {
    setWatchJobId(jobId);
    setView('scan');
  }, []);

  const value = useMemo(
    () => ({
      view,
      setView,
      request,
      openReference,
      watchJobId,
      watchScan,
    }),
    [view, request, openReference, watchJobId, watchScan],
  );

  return (
    <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
  );
}

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error('Falta la navegación de la aplicación.');
  return value;
}

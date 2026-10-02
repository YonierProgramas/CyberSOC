import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type CopilotFocus =
  | { kind: 'RESULT'; resultId: string; label: string }
  | { kind: 'JOB'; jobId: string; label: string };

const CopilotFocusContext = createContext<{
  focus: CopilotFocus | null;
  setFocus: (focus: CopilotFocus | null) => void;
} | null>(null);

export function CopilotFocusProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<CopilotFocus | null>(null);
  const value = useMemo(() => ({ focus, setFocus }), [focus]);
  return (
    <CopilotFocusContext.Provider value={value}>
      {children}
    </CopilotFocusContext.Provider>
  );
}

export function useCopilotFocus() {
  const value = useContext(CopilotFocusContext);
  if (!value) throw new Error('Falta el foco del Copilot.');
  return value;
}

export function pathLabel(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

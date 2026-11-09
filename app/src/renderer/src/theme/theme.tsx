import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type AppTheme = 'dark' | 'light';

const THEME_KEY = 'cybersoc-theme';
const MOTION_KEY = 'cybersoc-motion';

function readTheme(): AppTheme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function readReducedMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) === 'reduce';
  } catch {
    return false;
  }
}

function applyTheme(theme: AppTheme, reducedMotion: boolean) {
  document.documentElement.dataset.theme = theme;
  if (reducedMotion) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
}

const ThemeContext = createContext<{
  theme: AppTheme;
  reducedMotion: boolean;
  setTheme: (theme: AppTheme) => void;
  setReducedMotion: (value: boolean) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(() => {
    const initial = readTheme();
    applyTheme(initial, readReducedMotion());
    return initial;
  });
  const [reducedMotion, setReducedState] = useState(readReducedMotion);

  const value = useMemo(
    () => ({
      theme,
      reducedMotion,
      setTheme: (next: AppTheme) => {
        setThemeState(next);
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          /* The visual preference is not an engine setting. */
        }
        applyTheme(next, reducedMotion);
      },
      setReducedMotion: (next: boolean) => {
        setReducedState(next);
        try {
          localStorage.setItem(MOTION_KEY, next ? 'reduce' : 'full');
        } catch {
          /* Same as the theme: local presentation only. */
        }
        applyTheme(theme, next);
      },
    }),
    [theme, reducedMotion],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('Falta el tema de la aplicación.');
  return value;
}

import { createContext, useEffect, useState } from 'react';

export type ThemeName = 'light' | 'dark';
const KEY = 'cr-theme';

export function readTheme(): ThemeName {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // приватный режим — берём системную
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useThemePreference(): [ThemeName, (t: ThemeName) => void] {
  const [theme, setTheme] = useState<ThemeName>(readTheme);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);
  return [theme, setTheme];
}

export const ThemeContext = createContext<{ theme: ThemeName; setTheme: (t: ThemeName) => void }>({
  theme: 'light',
  setTheme: () => {},
});

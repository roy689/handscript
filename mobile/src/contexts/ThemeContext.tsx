import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightColors, darkColors } from '../theme';

export type ThemeColors = typeof lightColors;
export type ThemeMode   = 'light' | 'dark';

interface ThemeContextValue {
  colors:      ThemeColors;
  theme:       ThemeMode;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  colors:      lightColors,
  theme:       'light',
  toggleTheme: () => {},
});

const STORAGE_KEY = 'pref_theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>('light');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(v => { if (v === 'dark') setTheme('dark'); })
      .catch(() => {});
  }, []);

  const toggleTheme = useCallback(async () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    await AsyncStorage.setItem(STORAGE_KEY, next);
  }, [theme]);

  const colors = theme === 'dark' ? darkColors : lightColors;

  return (
    <ThemeContext.Provider value={{ colors, theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);

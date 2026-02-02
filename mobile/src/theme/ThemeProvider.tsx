import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type ThemeMode = 'light' | 'dark';

type ThemeColors = {
  background: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  primaryText: string;
  inputBg: string;
  buttonBg: string;
  danger: string;
};

type ThemeContextValue = {
  mode: ThemeMode;
  colors: ThemeColors;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const lightColors: ThemeColors = {
  background: '#f5f7fb',
  card: '#ffffff',
  border: '#e5e7eb',
  text: '#0f172a',
  muted: '#64748b',
  primary: '#2563eb',
  primaryText: '#ffffff',
  inputBg: '#f8fafc',
  buttonBg: '#e2e8f0',
  danger: '#ef4444',
};

const darkColors: ThemeColors = {
  background: '#050505',
  card: '#0f1115',
  border: '#2a2d35',
  text: '#f5f7fb',
  muted: '#9ca3af',
  primary: '#06b6d4',
  primaryText: '#031016',
  inputBg: '#0b0d12',
  buttonBg: '#111827',
  danger: '#ef4444',
};

const STORAGE_KEY = 'themeMode';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('light');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      if (value === 'dark' || value === 'light') setMode(value);
    });
  }, []);

  const toggle = () => {
    setMode((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      AsyncStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  };

  const colors = useMemo(() => (mode === 'dark' ? darkColors : lightColors), [mode]);

  return <ThemeContext.Provider value={{ mode, colors, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

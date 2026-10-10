import { useColorScheme } from 'react-native';

const light = {
  bg: '#faf9f5',
  card: '#ffffff',
  text: '#141413',
  muted: '#6b6b6b',
  border: '#d9d6cc',
  accent: '#c15f3c',
  accentText: '#ffffff',
  error: '#b3261e',
  ok: '#1a7f37',
};

const dark: typeof light = {
  bg: '#141413',
  card: '#1f1e1d',
  text: '#f5f4ee',
  muted: '#a3a199',
  border: '#3a3935',
  accent: '#d97757',
  accentText: '#141413',
  error: '#f2b8b5',
  ok: '#7ee2a0',
};

export function useTheme() {
  return useColorScheme() === 'dark' ? dark : light;
}

import { Button, Menu } from '../../components/ui';
import { useTheme, type ThemePreference } from '../../theme/ThemeProvider';

const LABELS: Record<ThemePreference, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
};

export function ThemeMenu() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <Menu
      trigger={
        <Button variant="ghost" size="icon" aria-label={`Theme: ${LABELS[preference]}`}>
          {resolved === 'dark' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="currentColor" />
              <path
                d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </Button>
      }
      items={(Object.keys(LABELS) as ThemePreference[]).map((p) => ({
        label: (p === preference ? '✓ ' : ' ') + LABELS[p],
        onSelect: () => setPreference(p),
      }))}
    />
  );
}

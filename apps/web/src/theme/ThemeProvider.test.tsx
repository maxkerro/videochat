import { act, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeProvider';

function Probe() {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="state">{`${preference}/${resolved}`}</span>
      <button onClick={() => setPreference('dark')}>dark</button>
      <button onClick={() => setPreference('system')}>system</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  it('follows the system theme by default', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('state')).toHaveTextContent('system/light');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('applies and remembers an explicit choice, and can go back to system', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByText('dark').click());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('videochat.theme')).toBe('dark');

    act(() => screen.getByText('system').click());
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('videochat.theme')).toBeNull();
  });

  it('restores a saved choice on load', () => {
    localStorage.setItem('videochat.theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('state')).toHaveTextContent('dark/dark');
  });
});

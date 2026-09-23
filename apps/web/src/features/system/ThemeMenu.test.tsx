import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { ThemeMenu } from './ThemeMenu';

describe('ThemeMenu', () => {
  it('shows the moon icon and lets you switch to light', async () => {
    localStorage.setItem('videochat.theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeMenu />
      </ThemeProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Theme: Dark' });
    expect(trigger).toBeInTheDocument();

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Light/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../components/ui';
import { ThemeProvider } from '../theme/ThemeProvider';
import { UiGalleryPage } from './UiGalleryPage';

function renderGallery() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <UiGalleryPage />
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('UiGalleryPage (CHAT-006 living documentation)', () => {
  it('opens and closes the demo modal', async () => {
    renderGallery();
    await userEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    expect(screen.getByRole('dialog', { name: /Leave/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('runs a menu action', async () => {
    renderGallery();
    await userEvent.click(screen.getByRole('button', { name: /Open menu/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy text' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows success and error toasts', async () => {
    renderGallery();
    await userEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show error toast' }));
    expect(await screen.findByText('Couldn’t send')).toBeInTheDocument();
  });

  it('shows a loading state and then re-enables the demo button', async () => {
    renderGallery();
    await userEvent.click(screen.getByRole('button', { name: 'Click to load' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Click to load' })).not.toBeDisabled(),
      {
        timeout: 3000,
      },
    );
  }, 5000);
});

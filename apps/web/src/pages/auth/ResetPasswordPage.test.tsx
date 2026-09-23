import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAlwaysReturning } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

afterEach(() => vi.unstubAllGlobals());

describe('ResetPasswordPage', () => {
  it('shows an error when the link has no token', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/reset-password');
    await userEvent.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText(/missing its token/)).toBeInTheDocument();
  });

  it('validates the new password before submitting', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/reset-password?token=abc123');
    await userEvent.type(screen.getByLabelText('New password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText(/at least/i)).toBeInTheDocument();
  });

  it('resets the password and offers to go log in', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Password updated.' }));
    renderApp('/reset-password?token=abc123');
    await userEvent.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeInTheDocument();
  });
});

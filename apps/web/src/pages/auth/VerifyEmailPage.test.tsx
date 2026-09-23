import { screen } from '@testing-library/react';
import { fetchAlwaysReturning } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

afterEach(() => vi.unstubAllGlobals());

describe('VerifyEmailPage', () => {
  it('shows an error immediately when the link has no token', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/verify-email');
    expect(await screen.findByText(/missing its token/)).toBeInTheDocument();
  });

  it('verifies the token and confirms success', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Email verified.' }));
    renderApp('/verify-email?token=abc123');
    expect(
      await screen.findByText('Your email is verified. You can log in now.'),
    ).toBeInTheDocument();
  });

  it('shows the server error message for an invalid or expired token', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Invalid or expired token' }, 400));
    renderApp('/verify-email?token=stale-token');
    expect(await screen.findByText('Invalid or expired token')).toBeInTheDocument();
  });
});

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAlwaysReturning } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

const session = {
  accessToken: 'token-1',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  user: {
    id: '00000000-0000-0000-0000-000000000000',
    username: 'ada',
    displayName: 'Ada Lovelace',
    avatarUrl: null,
    email: 'ada@example.com',
    emailVerified: true,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('AccountMenu (in the app shell)', () => {
  it('shows a log-in link when signed out', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows the account menu and navigates to the profile page when signed in', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning(session));
    const { router } = renderApp('/');
    const trigger = await screen.findByRole('button', { name: 'Account: Ada Lovelace' });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Profile' }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/profile'));
  });

  it('logs out and navigates to /login', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning(session));
    const { router } = renderApp('/');
    const trigger = await screen.findByRole('button', { name: 'Account: Ada Lovelace' });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});

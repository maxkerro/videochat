import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api';
import { AuthProvider, useAuth, withAuthRetry } from './AuthContext';

/** AuthContext now clears the query cache on login/logout, so it needs a QueryClientProvider
 *  ancestor (matching how it's actually used inside <Providers>) even in these unit tests. */
function renderWithAuth(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <p data-testid="status">{auth.status}</p>
      <p data-testid="user">{auth.user?.displayName ?? 'none'}</p>
      <button onClick={() => void auth.login({ email: 'ada@example.com', password: 'hunter22' })}>
        Log in
      </button>
      <button onClick={() => void auth.logout()}>Log out</button>
    </div>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider', () => {
  it('starts loading, then becomes anonymous when the silent refresh has no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'no cookie' }, 401)));
    renderWithAuth(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('becomes authenticated when the silent refresh succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(session)));
    renderWithAuth(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Ada Lovelace');
  });

  it('logs in and then logs out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'no cookie' }, 401)) // initial silent refresh
      .mockResolvedValueOnce(jsonResponse(session)) // login
      .mockResolvedValueOnce(jsonResponse({ message: 'Logged out.' })); // logout
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));

    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('clears the query cache on logout, and again on a subsequent login', async () => {
    // None of the app's query keys are scoped by user id, so a second person signing in on the
    // same tab right after the first logs out must not see the first person's cached
    // conversations/messages -- confirm logout (and login, defensively) both clear the cache.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'no cookie' }, 401)) // initial silent refresh
      .mockResolvedValueOnce(jsonResponse(session)) // login
      .mockResolvedValueOnce(jsonResponse({ message: 'Logged out.' })) // logout
      .mockResolvedValueOnce(jsonResponse(session)); // second login
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient } = renderWithAuth(<Probe />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));

    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    queryClient.setQueryData(['conversations'], [{ id: 'conv-from-ada' }]);
    expect(queryClient.getQueryData(['conversations'])).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();

    queryClient.setQueryData(['conversations'], [{ id: 'leftover-after-logout' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(queryClient.getQueryData(['conversations'])).toBeUndefined();
  });
});

describe('withAuthRetry', () => {
  it('runs the request once when it succeeds', async () => {
    const send = vi.fn().mockResolvedValue('ok');
    const result = await withAuthRetry({ accessToken: 'tok', refresh: vi.fn() }, send);
    expect(result).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refreshes once and retries on a 401, then succeeds', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, 'expired'))
      .mockResolvedValueOnce('ok');
    const refresh = vi.fn().mockResolvedValue('fresh-token');
    const result = await withAuthRetry({ accessToken: 'stale-token', refresh }, send);
    expect(result).toBe('ok');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, 'stale-token');
    expect(send).toHaveBeenNthCalledWith(2, 'fresh-token');
  });

  it('rethrows the original 401 when the refresh itself fails to produce a session', async () => {
    const send = vi.fn().mockRejectedValue(new ApiError(401, 'expired'));
    const refresh = vi.fn().mockResolvedValue(null);
    await expect(withAuthRetry({ accessToken: 'stale', refresh }, send)).rejects.toMatchObject({
      status: 401,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when there is no access token at all', async () => {
    const send = vi.fn();
    await expect(
      withAuthRetry({ accessToken: null, refresh: vi.fn() }, send),
    ).rejects.toMatchObject({ status: 401 });
    expect(send).not.toHaveBeenCalled();
  });
});

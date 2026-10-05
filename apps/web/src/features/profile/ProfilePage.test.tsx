import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

const baseUser = {
  id: '00000000-0000-0000-0000-000000000000',
  username: 'ada',
  displayName: 'Ada Lovelace',
  avatarUrl: null,
  email: 'ada@example.com',
  emailVerified: true,
};

function session(user = baseUser) {
  return { accessToken: 'token-1', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', user };
}

/** Routes fetch calls by method/path, since ProfilePage exercises several distinct endpoints
 *  (refresh, username availability, update, avatar upload) in one screen. */
function routedFetch(
  handlers: Record<string, (url: URL, init?: RequestInit) => Response>,
): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    // VITE_API_URL is unset in CI (apps/web/.env is gitignored, like apps/api's), so apiGet()
    // calls fetch() with a relative path there instead of an absolute localhost URL -- new URL()
    // requires a base for a relative input, so this must always supply one.
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    for (const [key, handler] of Object.entries(handlers)) {
      const [method, path] = key.split(' ');
      if ((init?.method ?? 'GET') === method && url.pathname === path) {
        return Promise.resolve(handler(url, init));
      }
    }
    throw new Error(`Unhandled request: ${init?.method ?? 'GET'} ${url.pathname}`);
  }) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('ProfilePage', () => {
  it('saves a changed display name', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'PATCH /me': () => jsonResponse({ ...baseUser, displayName: 'Ada L.' }),
      }),
    );
    renderApp('/settings');
    const input = await screen.findByLabelText('Display name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Ada L.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
  });

  it('checks username availability and blocks saving a taken name', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /users/username-availability': () => jsonResponse({ available: false }),
      }),
    );
    renderApp('/settings');
    const input = await screen.findByLabelText('Username');
    await userEvent.clear(input);
    await userEvent.type(input, 'takenname');
    expect(await screen.findByText('Username already taken')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('allows saving once an available username is confirmed', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /users/username-availability': () => jsonResponse({ available: true }),
        'PATCH /me': () => jsonResponse({ ...baseUser, username: 'freename' }),
      }),
    );
    renderApp('/settings');
    const input = await screen.findByLabelText('Username');
    await userEvent.clear(input);
    await userEvent.type(input, 'freename');
    expect(await screen.findByText('Username available')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
  });

  it('uploads a new avatar', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'POST /me/avatar': () =>
          jsonResponse({ ...baseUser, avatarUrl: 'https://cdn.test/a.webp' }),
      }),
    );
    renderApp('/settings');
    await screen.findByLabelText('Display name');
    const file = new File(['x'], 'avatar.png', { type: 'image/png' });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(fileInput, file);
    expect(await screen.findByText('Avatar updated')).toBeInTheDocument();
  });

  it('rejects an oversized avatar client-side without calling the API', async () => {
    vi.stubGlobal('fetch', routedFetch({ 'POST /auth/refresh': () => jsonResponse(session()) }));
    renderApp('/settings');
    await screen.findByLabelText('Display name');
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(fileInput, big);
    expect(await screen.findByText('Image too large')).toBeInTheDocument();
  });

  describe('CHAT-021 blocklist', () => {
    const blocked = {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'ben',
      displayName: 'Ben Okafor',
      avatarUrl: null,
    };

    it('shows a message when nobody is blocked', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          'GET /users/blocked': () => jsonResponse({ users: [] }),
        }),
      );
      renderApp('/settings');
      expect(await screen.findByText(/haven.t blocked anyone/i)).toBeInTheDocument();
    });

    it('lists blocked users with an Unblock action that removes them from the list', async () => {
      let unblocked = false;
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          'GET /users/blocked': () => jsonResponse({ users: unblocked ? [] : [blocked] }),
          [`DELETE /users/${blocked.id}/block`]: () => {
            unblocked = true;
            return jsonResponse({ message: 'Unblocked.' });
          },
        }),
      );
      renderApp('/settings');
      expect(await screen.findByText('Ben Okafor')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Unblock' }));

      await waitFor(() => expect(screen.queryByText('Ben Okafor')).not.toBeInTheDocument());
      expect(await screen.findByText(/haven.t blocked anyone/i)).toBeInTheDocument();
    });
  });
});

describe('Settings (CHAT-037)', () => {
  const settings = {
    readReceipts: true,
    lastSeenVisibility: 'everyone',
    notifications: { enabled: true, sound: true, previews: true },
    theme: 'system',
  };

  it('saves a privacy setting the moment it changes', async () => {
    let patched: unknown;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session({ ...baseUser, settings } as never)),
        'GET /users/blocked': () => jsonResponse({ users: [] }),
        'PATCH /me/settings': (_u, init) => {
          patched = JSON.parse(String(init?.body));
          return jsonResponse({ ...baseUser, settings: { ...settings, readReceipts: false } });
        },
      }),
    );
    renderApp('/settings');
    const toggle = await screen.findByRole('switch', { name: /Read receipts/ });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(patched).toEqual({ readReceipts: false }));
    expect(toggle).not.toBeChecked();
  });

  it('deletes the account only after the password, then signs out', async () => {
    let deleteBody: unknown;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session({ ...baseUser, settings } as never)),
        'GET /users/blocked': () => jsonResponse({ users: [] }),
        'POST /auth/delete-account': (_u, init) => {
          deleteBody = JSON.parse(String(init?.body));
          return new Response(null, { status: 204 });
        },
        'POST /auth/logout': () => jsonResponse({ message: 'Logged out.' }),
      }),
    );
    const { router } = renderApp('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    const confirm = screen.getByRole('button', { name: 'Delete my account' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Password'), 'my-password');
    await userEvent.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(deleteBody).toEqual({ password: 'my-password' });
  });

  it('redirects the old /profile address', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /users/blocked': () => jsonResponse({ users: [] }),
      }),
    );
    const { router } = renderApp('/profile');
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
  });
});

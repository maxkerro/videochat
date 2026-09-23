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
    const url = new URL(typeof input === 'string' ? input : input.toString());
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
    renderApp('/profile');
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
    renderApp('/profile');
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
    renderApp('/profile');
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
    renderApp('/profile');
    await screen.findByLabelText('Display name');
    const file = new File(['x'], 'avatar.png', { type: 'image/png' });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(fileInput, file);
    expect(await screen.findByText('Avatar updated')).toBeInTheDocument();
  });

  it('rejects an oversized avatar client-side without calling the API', async () => {
    vi.stubGlobal('fetch', routedFetch({ 'POST /auth/refresh': () => jsonResponse(session()) }));
    renderApp('/profile');
    await screen.findByLabelText('Display name');
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(fileInput, big);
    expect(await screen.findByText('Image too large')).toBeInTheDocument();
  });
});

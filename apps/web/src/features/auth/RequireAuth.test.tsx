import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Providers } from '../../Providers';
import { RequireAuth } from './RequireAuth';

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

function renderGuarded(initial: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/secret',
        element: (
          <RequireAuth>
            <p>Secret content</p>
          </RequireAuth>
        ),
      },
      { path: '/login', element: <p>Login page</p> },
    ],
    { initialEntries: [initial] },
  );
  return {
    router,
    ...render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('RequireAuth', () => {
  it('redirects to /login when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, 401)));
    const { router } = renderGuarded('/secret');
    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/login');
  });

  it('renders the protected content once a session is confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(session)));
    renderGuarded('/secret');
    await waitFor(() => expect(screen.getByText('Secret content')).toBeInTheDocument());
  });

  it('does not redirect while the initial session check is still pending', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderGuarded('/secret');
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument();
  });
});

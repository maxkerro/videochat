import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse } from '../../test/mockFetch';
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

function routed(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const handler = handlers[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (handler) return Promise.resolve(handler(init));
    // Anything the signed-in app shell loads afterwards: answer emptily.
    return Promise.resolve(jsonResponse(url.pathname === '/auth/refresh' ? {} : [], 401));
  }) as unknown as typeof fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('signing in with an emailed code (CHAT-081)', () => {
  it('offers the code while password sign-in is delayed, and signs in with it', async () => {
    const bodies: Record<string, unknown> = {};
    const fetchMock = routed({
      'POST /auth/login': () =>
        jsonResponse(
          {
            message:
              'Too many failed attempts. Try again in 30 seconds, or sign in with an emailed code.',
            code: 'login_throttled',
          },
          403,
        ),
      'POST /auth/login-link': (init) => {
        bodies.link = JSON.parse(String(init?.body));
        return jsonResponse(
          { message: 'If that account exists, we emailed it a sign-in link and code.' },
          202,
        );
      },
      'POST /auth/login-link/verify': (init) => {
        bodies.verify = JSON.parse(String(init?.body));
        return jsonResponse(session);
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { router } = renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email or username'), 'ada');
    await userEvent.type(screen.getByLabelText('Password'), 'a-strong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText(/Try again in 30 seconds/)).toBeInTheDocument();
    // Not mistaken for "verify your email".
    expect(screen.queryByText(/Verify your email/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in code instead' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(bodies.link).toEqual({ identifier: 'ada' });

    await userEvent.type(screen.getByLabelText('Code'), '12345');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter the 6-digit code from the email')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Code'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(bodies.verify).toEqual({ identifier: 'ada', code: '123456' });
  });

  it('asks for the email or username before sending a code', async () => {
    vi.stubGlobal('fetch', routed({}));
    renderApp('/login');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Email me a sign-in code instead' }),
    );
    expect(await screen.findByText('Enter your email or username first')).toBeInTheDocument();
  });

  it('signs in from the emailed link only when the person clicks', async () => {
    const verify = vi.fn(() => jsonResponse(session));
    vi.stubGlobal('fetch', routed({ 'POST /auth/login-link/verify': verify }));
    const { router } = renderApp('/login-link?token=abc123');
    const button = await screen.findByRole('button', { name: 'Sign in' });
    expect(verify).not.toHaveBeenCalled();
    await userEvent.click(button);
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('says so when the link was already used', async () => {
    vi.stubGlobal(
      'fetch',
      routed({
        'POST /auth/login-link/verify': () =>
          jsonResponse({ message: 'This sign-in link is invalid or has expired' }, 400),
      }),
    );
    renderApp('/login-link?token=used');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('This sign-in link is invalid or has expired'),
    ).toBeInTheDocument();
  });
});

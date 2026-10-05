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

async function submitLogin(identifier = 'ada@example.com', password = 'a-strong-password') {
  await userEvent.type(screen.getByLabelText('Email or username'), identifier);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('LoginPage', () => {
  it('shows validation errors for an empty form without calling the API', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/login');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Enter your email or username')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
  });

  it('logs in and lands on the home route', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning(session));
    const { router } = renderApp('/login');
    await submitLogin();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('logs in with a username, sending it as the identifier', async () => {
    const fetchMock = fetchAlwaysReturning(session);
    vi.stubGlobal('fetch', fetchMock);
    const { router } = renderApp('/login');
    await submitLogin('ada');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const login = calls.find(([input]) => String(input).endsWith('/auth/login'));
    expect(JSON.parse(String(login![1]!.body))).toEqual({
      identifier: 'ada',
      password: 'a-strong-password',
    });
  });

  it('shows a generic invalid-credentials message on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      fetchAlwaysReturning({ message: 'Incorrect email/username or password' }, 401),
    );
    renderApp('/login');
    await submitLogin();
    expect(await screen.findByText('Incorrect email/username or password')).toBeInTheDocument();
  });

  it('offers to resend the verification email on a 403', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Email not verified' }, 403));
    renderApp('/login');
    await submitLogin();
    expect(await screen.findByText(/Verify your email/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend the email' })).toBeInTheDocument();
  });

  it("doesn't offer a resend after a username login (there's no address to send to)", async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Email not verified' }, 403));
    renderApp('/login');
    await submitLogin('ada');
    expect(await screen.findByText(/log in with your email address/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend the email' })).not.toBeInTheDocument();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

const health = {
  status: 'ok',
  version: 'test',
  uptimeSeconds: 5,
  checks: { database: 'up', redis: 'up' },
};

const baseUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'anna',
  displayName: 'Anna Schmidt',
  avatarUrl: null,
  email: 'anna@example.com',
  emailVerified: true,
};

const ben = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'ben',
  displayName: 'Ben Okafor',
  avatarUrl: null,
};

const clara = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'clara',
  displayName: 'Clara Novak',
  avatarUrl: null,
};

const projectId = '55555555-5555-4555-8555-555555555555';
const benConversationId = '66666666-6666-4666-8666-666666666666';
const claraConversationId = '77777777-7777-4777-8777-777777777777';

function session() {
  return {
    accessToken: 'token-1',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    user: baseUser,
  };
}

function conversations() {
  return [
    {
      id: projectId,
      type: 'group' as const,
      title: 'Project Relay',
      lastSeq: 5,
      lastMessageAt: '2026-01-01T10:42:00.000Z',
      role: 'member' as const,
      lastReadSeq: 3,
      peer: null,
    },
    {
      id: benConversationId,
      type: 'direct' as const,
      title: null,
      lastSeq: 2,
      lastMessageAt: '2026-01-01T09:15:00.000Z',
      role: 'member' as const,
      lastReadSeq: 2,
      peer: ben,
    },
    {
      id: claraConversationId,
      type: 'direct' as const,
      title: null,
      lastSeq: 1,
      lastMessageAt: '2025-12-29T18:20:00.000Z',
      role: 'member' as const,
      lastReadSeq: 1,
      peer: clara,
    },
  ];
}

/** Routes fetch calls by method/path (see ProfilePage.test.tsx for the original pattern). */
function routedFetch(
  handlers: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>,
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

function authedFetch(extra: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
  return routedFetch({
    'GET /health': () => jsonResponse(health),
    'POST /auth/refresh': () => jsonResponse(session()),
    'GET /conversations': () => jsonResponse(conversations()),
    ...extra,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('shows the conversation list and an empty chat pane', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Select a conversation' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
    expect(await screen.findByRole('link', { name: /Ben Okafor/ })).toBeInTheDocument();
  });

  it('opens a conversation from the list', async () => {
    vi.stubGlobal(
      'fetch',
      authedFetch({
        [`GET /conversations/${benConversationId}`]: () => jsonResponse(conversations()[1]!),
        [`GET /conversations/${benConversationId}/messages`]: () => jsonResponse([]),
      }),
    );
    const { router } = renderApp('/');
    await userEvent.click(await screen.findByRole('link', { name: /Ben Okafor/ }));
    expect(router.state.location.pathname).toBe(`/c/${benConversationId}`);
    expect(await screen.findByRole('heading', { name: 'Ben Okafor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });

  it('filters conversations by search', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');
    await screen.findByRole('link', { name: /Clara Novak/ });
    await userEvent.type(screen.getByLabelText('Search conversations'), 'clara');
    expect(screen.getByRole('link', { name: /Clara Novak/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ben Okafor/ })).not.toBeInTheDocument();
  });

  it('opens the new chat dialog and closes it with Escape', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the new chat dialog on Cancel, without starting a chat', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('finds a person by username search and starts a new direct chat', async () => {
    const newConversationId = '88888888-8888-4888-8888-888888888888';
    const dara = {
      id: '99999999-9999-4999-8999-999999999999',
      username: 'dara',
      displayName: 'Dara Singh',
      avatarUrl: null,
    };
    vi.stubGlobal(
      'fetch',
      authedFetch({
        'GET /users/search': (url) =>
          url.searchParams.get('q') === 'dara'
            ? jsonResponse({ users: [dara] })
            : jsonResponse({ users: [] }),
        'POST /conversations/direct': (_url, init) => {
          const body = JSON.parse(init!.body as string) as { userId: string };
          expect(body.userId).toBe(dara.id);
          return jsonResponse({
            id: newConversationId,
            type: 'direct',
            title: null,
            lastSeq: 0,
            lastMessageAt: null,
            role: 'member',
            lastReadSeq: 0,
            peer: dara,
          });
        },
        [`GET /conversations/${newConversationId}`]: () =>
          jsonResponse({
            id: newConversationId,
            type: 'direct',
            title: null,
            lastSeq: 0,
            lastMessageAt: null,
            role: 'member',
            lastReadSeq: 0,
            peer: dara,
          }),
        [`GET /conversations/${newConversationId}/messages`]: () => jsonResponse([]),
      }),
    );
    const { router } = renderApp('/');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.type(screen.getByLabelText('Username or email'), 'dara');

    const result = await screen.findByRole('button', { name: /Dara Singh/ });
    await userEvent.click(result);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${newConversationId}`));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Dara Singh' })).toBeInTheDocument();
  });

  it('shows an empty state and hides non-matching conversations when a search matches nothing', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });
    await userEvent.type(screen.getByLabelText('Search conversations'), 'nobody-has-this-name');
    expect(screen.getByText('No conversations match "nobody-has-this-name".')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ben Okafor/ })).not.toBeInTheDocument();
  });

  it('shows an unread badge on conversations with unread messages, and none on read ones', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');
    const projectLink = await screen.findByRole('link', { name: /Project Relay/ });
    expect(within(projectLink).getByLabelText('2 unread')).toBeInTheDocument();
    const benLink = screen.getByRole('link', { name: /Ben Okafor/ });
    expect(within(benLink).queryByText(/unread/)).not.toBeInTheDocument();
  });

  it('renders the not-found page for an unknown route', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/this/route/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Go to conversations' }));
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
  });

  it('lazy-loads the /ui design system gallery route', async () => {
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/ui');
    expect(await screen.findByRole('heading', { name: 'UI kit' })).toBeInTheDocument();
  });

  it('reports when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderApp('/');
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('Can’t reach the server'),
      { timeout: 4000 },
    );
  });
});

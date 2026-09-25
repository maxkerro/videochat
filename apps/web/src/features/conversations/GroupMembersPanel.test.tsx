import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

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

const carl = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'carl',
  displayName: 'Carl Diaz',
  avatarUrl: null,
};

const groupId = '77777777-7777-4777-8777-777777777777';

function session() {
  return {
    accessToken: 'token-1',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    user: baseUser,
  };
}

function groupConversation(overrides: Partial<{ role: 'admin' | 'member'; title: string }> = {}) {
  return {
    id: groupId,
    type: 'group' as const,
    title: overrides.title ?? 'Weekend trip',
    lastSeq: 1,
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    role: overrides.role ?? ('admin' as const),
    lastReadSeq: 1,
    peer: null,
  };
}

function memberRow(user: typeof baseUser | typeof ben, role: 'admin' | 'member') {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: null,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Routes fetch calls by method/path, same pattern as ChatPane.test.tsx/AppShell.test.tsx. */
function routedFetch(
  handlers: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>,
): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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

async function openMembersPanel() {
  renderApp(`/c/${groupId}`);
  await screen.findByRole('heading', { name: /Weekend trip|Renamed group/ });
  await userEvent.click(screen.getByRole('button', { name: 'Members' }));
  await screen.findByRole('dialog', { name: 'Group members' });
}

describe('GroupMembersPanel (CHAT-018)', () => {
  it('AC: members list shows roles', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
        [`GET /conversations/${groupId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /conversations/${groupId}/members`]: () =>
          jsonResponse([memberRow(baseUser, 'admin'), memberRow(ben, 'member')]),
      }),
    );
    await openMembersPanel();

    expect(screen.getByText('Anna Schmidt')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('Ben Okafor')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
  });

  it('lets an admin rename the group', async () => {
    let renamedTo: string | null = null;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
        [`GET /conversations/${groupId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /conversations/${groupId}/members`]: () =>
          jsonResponse([memberRow(baseUser, 'admin')]),
        [`PATCH /conversations/${groupId}`]: (_url, init) => {
          renamedTo = (JSON.parse(init!.body as string) as { title: string }).title;
          return jsonResponse(groupConversation({ title: renamedTo }));
        },
      }),
    );
    await openMembersPanel();

    const input = screen.getByLabelText('Group name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed group');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(renamedTo).toBe('Renamed group'));
  });

  it('does not show rename or remove controls to a plain member, only leave', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${groupId}`]: () =>
          jsonResponse(groupConversation({ role: 'member' })),
        [`GET /conversations/${groupId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /conversations/${groupId}/members`]: () =>
          jsonResponse([memberRow(baseUser, 'member'), memberRow(ben, 'admin')]),
      }),
    );
    await openMembersPanel();

    expect(screen.queryByLabelText('Group name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add a member')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave group' })).toBeInTheDocument();
  });

  it('lets an admin add a member by search', async () => {
    let addedIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
        [`GET /conversations/${groupId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /conversations/${groupId}/members`]: () =>
          jsonResponse([memberRow(baseUser, 'admin')]),
        'GET /users/search': () => jsonResponse({ users: [carl] }),
        [`POST /conversations/${groupId}/members`]: (_url, init) => {
          addedIds = (JSON.parse(init!.body as string) as { memberIds: string[] }).memberIds;
          return jsonResponse(groupConversation());
        },
      }),
    );
    await openMembersPanel();

    await userEvent.type(screen.getByLabelText('Add a member'), 'carl');
    const addButton = await screen.findByRole('button', { name: 'Add' });
    await userEvent.click(addButton);

    await waitFor(() => expect(addedIds).toEqual([carl.id]));
  });

  it('lets an admin remove a member', async () => {
    let removedPath: string | null = null;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
        [`GET /conversations/${groupId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /conversations/${groupId}/members`]: () =>
          jsonResponse([memberRow(baseUser, 'admin'), memberRow(ben, 'member')]),
        [`DELETE /conversations/${groupId}/members/${ben.id}`]: (url) => {
          removedPath = url.pathname;
          return new Response(null, { status: 200 });
        },
      }),
    );
    await openMembersPanel();

    await userEvent.click(screen.getByRole('button', { name: `Remove ${ben.displayName}` }));

    await waitFor(() => expect(removedPath).toBe(`/conversations/${groupId}/members/${ben.id}`));
  });

  it('lets any member leave, and returns to the conversation list', async () => {
    let left = false;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([]),
        [`GET /conversations/${groupId}`]: () =>
          jsonResponse(groupConversation({ role: 'member' })),
        [`GET /conversations/${groupId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /conversations/${groupId}/members`]: () =>
          jsonResponse([memberRow(baseUser, 'member')]),
        [`POST /conversations/${groupId}/leave`]: () => {
          left = true;
          return new Response(null, { status: 201 });
        },
      }),
    );
    const { router } = renderApp(`/c/${groupId}`);
    await screen.findByRole('heading', { name: 'Weekend trip' });
    await userEvent.click(screen.getByRole('button', { name: 'Members' }));
    await screen.findByRole('dialog', { name: 'Group members' });

    await userEvent.click(screen.getByRole('button', { name: 'Leave group' }));

    await waitFor(() => expect(left).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});

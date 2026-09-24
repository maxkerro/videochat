import { screen, waitFor, within } from '@testing-library/react';
import { makeEnvelope } from '@videochat/shared';
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

const peer = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'ben',
  displayName: 'Ben Okafor',
  avatarUrl: null,
};
const otherPeer = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'clara',
  displayName: 'Clara Novak',
  avatarUrl: null,
};

const conversationWithBen = '44444444-4444-4444-8444-444444444444';
const conversationWithClara = '55555555-5555-4555-8555-555555555555';

function session() {
  return {
    accessToken: 'token-1',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    user: baseUser,
  };
}

function benConversation() {
  return {
    id: conversationWithBen,
    type: 'direct' as const,
    title: null,
    lastSeq: 1,
    lastMessageAt: '2026-01-01T09:00:00.000Z',
    role: 'member' as const,
    lastReadSeq: 1,
    peer,
  };
}

function claraConversation() {
  return {
    id: conversationWithClara,
    type: 'direct' as const,
    title: null,
    lastSeq: 3,
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    role: 'member' as const,
    lastReadSeq: 3,
    peer: otherPeer,
  };
}

function baseMessage() {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    conversationId: conversationWithBen,
    seq: 2,
    senderId: peer.id,
    clientMsgId: null as string | null,
    type: 'text' as const,
    body: 'hi again',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T11:00:00.000Z',
  };
}

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

/** Minimal fake of the browser WebSocket (mirrors ChatPane.test.tsx's), used to drive
 *  RealtimeProvider from the outside and simulate a `message.new` arriving live. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  readyState = 0;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event?: unknown) => void) {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  emit(type: string, event?: unknown) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('ConversationList', () => {
  it('renders conversations in the order the server returns them, and shows unread counts', async () => {
    // Client-side sorting (byRecency) only ever runs in response to a live event -- on first
    // load the list is rendered in whatever order the server returned, so this checks that
    // pass-through, not that the client re-sorts by activity (nothing here would fail if
    // byRecency were deleted).
    const unreadBen = { ...benConversation(), lastSeq: 2, lastReadSeq: 1 };
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([claraConversation(), unreadBen]),
      }),
    );
    renderApp('/');

    const links = await screen.findAllByRole('link', { name: /Okafor|Novak/ });
    expect(links[0]).toHaveTextContent('Clara Novak');
    expect(links[1]).toHaveTextContent('Ben Okafor');
    // Clara's conversation is fully read (lastSeq === lastReadSeq): no badge at all.
    expect(within(links[0]!).queryByLabelText(/unread/)).not.toBeInTheDocument();
    // Ben's has one unread message (lastSeq 2, lastReadSeq 1): the badge shows it.
    expect(within(links[1]!).getByLabelText('1 unread')).toBeInTheDocument();
  });

  it('moves a conversation to the top and bumps its unread count when a message arrives live', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([claraConversation(), benConversation()]),
      }),
    );
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    const incoming = baseMessage();
    socket.emit('message', {
      data: JSON.stringify(makeEnvelope('message.new', incoming, incoming.id)),
    });

    await waitFor(() => {
      const links = screen.getAllByRole('link', { name: /Okafor|Novak/ });
      expect(links[0]).toHaveTextContent('Ben Okafor');
    });
    const benLink = screen.getByRole('link', { name: /Ben Okafor/ });
    expect(within(benLink).getByLabelText('1 unread')).toBeInTheDocument();
  });

  it('does not mark our own outgoing message as unread in the inbox', async () => {
    // Includes a second conversation (Clara's, with an earlier lastMessageAt) so there's a
    // positive signal to wait on -- Ben's conversation moving to the top -- before asserting the
    // badge is absent. Without that, the assertion could pass on its first synchronous check,
    // before the event was even applied, and would pass just as well if the sender check that
    // this test means to cover were deleted entirely.
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([claraConversation(), benConversation()]),
      }),
    );
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    const ownMessage = baseMessage();
    ownMessage.senderId = baseUser.id;
    socket.emit('message', {
      data: JSON.stringify(makeEnvelope('message.new', ownMessage, ownMessage.id)),
    });

    await waitFor(() => {
      const links = screen.getAllByRole('link', { name: /Okafor|Novak/ });
      expect(links[0]).toHaveTextContent('Ben Okafor');
    });
    const benLink = screen.getByRole('link', { name: /Ben Okafor/ });
    expect(within(benLink).queryByLabelText(/unread/)).not.toBeInTheDocument();
  });

  it('refetches the conversation list when a message arrives for a conversation not yet cached', async () => {
    let conversationsCalls = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => {
          conversationsCalls += 1;
          return jsonResponse([benConversation()]);
        },
      }),
    );
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });
    expect(conversationsCalls).toBe(1);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    // A conversation someone else just started with us and immediately sent into -- not in the
    // cached list at all -- should trigger a refetch rather than being silently dropped.
    const messageForUnknownConversation = {
      ...baseMessage(),
      conversationId: conversationWithClara,
    };
    socket.emit('message', {
      data: JSON.stringify(
        makeEnvelope(
          'message.new',
          messageForUnknownConversation,
          messageForUnknownConversation.id,
        ),
      ),
    });

    await waitFor(() => expect(conversationsCalls).toBe(2));
  });

  it('ignores a duplicate or older-seq message instead of moving lastMessageAt backwards', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([claraConversation(), benConversation()]),
      }),
    );
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    // benConversation() is already at lastSeq: 1 -- an event at seq 1 is a replay of the message
    // that produced that state (e.g. a reconnect gap-sync overlap), and must be a no-op.
    const stale = { ...baseMessage(), seq: 1 };
    socket.emit('message', {
      data: JSON.stringify(makeEnvelope('message.new', stale, stale.id)),
    });

    // Let any (wrongly-applied) update have a turn before asserting nothing changed.
    await Promise.resolve();
    await Promise.resolve();
    const links = screen.getAllByRole('link', { name: /Okafor|Novak/ });
    expect(links[0]).toHaveTextContent('Clara Novak');
    expect(links[1]).toHaveTextContent('Ben Okafor');
    expect(within(links[1]!).queryByLabelText(/unread/)).not.toBeInTheDocument();
  });
});

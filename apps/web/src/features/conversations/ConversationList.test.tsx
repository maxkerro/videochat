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
  it('shows an unread badge and orders conversations by most recent activity', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([claraConversation(), benConversation()]),
      }),
    );
    renderApp('/');

    const links = await screen.findAllByRole('link', { name: /Okafor|Novak/ });
    // Clara's conversation has the later lastMessageAt, so it renders first.
    expect(links[0]).toHaveTextContent('Clara Novak');
    expect(links[1]).toHaveTextContent('Ben Okafor');
    // Clara's conversation is fully read (lastSeq === lastReadSeq), so no unread badge at all.
    expect(within(links[0]!).queryByLabelText(/unread/)).not.toBeInTheDocument();
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
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        'GET /conversations': () => jsonResponse([benConversation()]),
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

    const benLink = await screen.findByRole('link', { name: /Ben Okafor/ });
    await waitFor(() => expect(within(benLink).queryByLabelText(/unread/)).not.toBeInTheDocument());
  });
});

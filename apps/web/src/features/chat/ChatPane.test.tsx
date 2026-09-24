import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeEnvelope } from '@videochat/shared';
import { ApiError } from '../../lib/api';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { shouldRetryQuery } from './ChatPane';

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

const conversationId = '33333333-3333-4333-8333-333333333333';
const otherPeer = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'clara',
  displayName: 'Clara Novak',
  avatarUrl: null,
};
const otherConversationId = '55555555-5555-4555-8555-555555555555';

function session() {
  return {
    accessToken: 'token-1',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    user: baseUser,
  };
}

function conversation() {
  return {
    id: conversationId,
    type: 'direct' as const,
    title: null,
    lastSeq: 1,
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    role: 'member' as const,
    lastReadSeq: 1,
    peer,
  };
}

function otherConversation() {
  return {
    id: otherConversationId,
    type: 'direct' as const,
    title: null,
    lastSeq: 0,
    lastMessageAt: null,
    role: 'member' as const,
    lastReadSeq: 0,
    peer: otherPeer,
  };
}

function message(overrides: Partial<ReturnType<typeof baseMessage>> = {}) {
  return { ...baseMessage(), ...overrides };
}

function baseMessage() {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    conversationId,
    seq: 1,
    senderId: peer.id,
    clientMsgId: null as string | null,
    type: 'text' as const,
    body: 'Hi there',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T10:00:00.000Z',
  };
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

/** A minimal fake of the browser WebSocket (mirrors lib/realtime.test.ts's), used here to drive
 *  RealtimeProvider's connection from the outside and simulate a `message.new` arriving live. */
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

describe('shouldRetryQuery', () => {
  it("never retries a 404, even on the very first failure -- not found or not a member won't change on its own", () => {
    expect(shouldRetryQuery(0, new ApiError(404, 'not found'))).toBe(false);
  });

  it('retries a non-404 ApiError (e.g. a 500) for 3 total attempts', () => {
    // react-query's failureCount is 0-based (0 on the first failure), so this is called with 0,
    // then 1, then (once the cap is hit) 2 -- three failed attempts total before giving up.
    const err = new ApiError(500, 'server error');
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(1, err)).toBe(true);
    expect(shouldRetryQuery(2, err)).toBe(false);
  });

  it('retries a plain network error (not an ApiError at all) the same way', () => {
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(2, new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('ChatPane', () => {
  it('shows a "not found" message for a conversation that does not exist or is not a member', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () =>
          jsonResponse({ message: 'Conversation not found' }, 404),
      }),
    );
    renderApp(`/c/${conversationId}`);
    expect(
      await screen.findByRole('heading', { name: 'Conversation not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to conversations' })).toBeInTheDocument();
  });

  it('shows a generic error with a retry button, not "not found", when loading the conversation fails for another reason', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => {
          attempts += 1;
          // A 500 gets a few automatic retries (shouldRetryQuery) before this shows an error at
          // all -- keep failing until then, so this also exercises that retry path, then let a
          // manual "Try again" click (below) finally succeed.
          return attempts <= 3
            ? jsonResponse({ message: 'Server error' }, 500)
            : jsonResponse(conversation());
        },
        [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([]),
      }),
    );
    renderApp(`/c/${conversationId}`);

    expect(
      await screen.findByRole('heading', { name: 'Something went wrong' }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Conversation not found' }),
    ).not.toBeInTheDocument();
    expect(attempts).toBe(3);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Ben Okafor' })).toBeInTheDocument();
  }, 10000);

  it('shows an error with a retry button, not an empty conversation, when message history fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ message: 'Not found' }, 404),
      }),
    );
    renderApp(`/c/${conversationId}`);

    // Without this, a failed history load rendered an empty message list, indistinguishable from
    // a conversation that genuinely has no messages yet.
    expect(await screen.findByText('Could not load messages.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ben Okafor' })).toBeInTheDocument();
  });

  it('loads history and shows a sent message optimistically before the server acks', async () => {
    let resolveSend!: (value: Response) => void;
    const sendPromise = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([message()]),
        [`POST /conversations/${conversationId}/messages`]: () => sendPromise,
      }),
    );
    renderApp(`/c/${conversationId}`);
    expect(await screen.findByText('Hi there')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Message'), 'hello there');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText('Sending…')).toBeInTheDocument();

    resolveSend(
      jsonResponse(
        message({
          id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
          seq: 2,
          senderId: baseUser.id,
          body: 'hello there',
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument());
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('lets a failed send be retried without creating a duplicate', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([]),
        [`POST /conversations/${conversationId}/messages`]: () => {
          attempts += 1;
          if (attempts === 1) return jsonResponse({ message: 'Server error' }, 500);
          return jsonResponse(
            message({
              id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
              senderId: baseUser.id,
              body: 'retry me',
            }),
          );
        },
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'retry me');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    const retryButton = await screen.findByRole('button', { name: 'Failed -- tap to retry' });
    await userEvent.click(retryButton);

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Failed -- tap to retry' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText('retry me')).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('does not leak a failed send into a conversation switched to afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([]),
        [`POST /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ message: 'Server error' }, 500),
        [`GET /conversations/${otherConversationId}`]: () => jsonResponse(otherConversation()),
        [`GET /conversations/${otherConversationId}/messages`]: () => jsonResponse([]),
      }),
    );
    const { router } = renderApp(`/c/${conversationId}`);
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'for ben only');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByRole('button', { name: 'Failed -- tap to retry' });

    await router.navigate(`/c/${otherConversationId}`);

    expect(await screen.findByRole('heading', { name: 'Clara Novak' })).toBeInTheDocument();
    expect(screen.queryByText('for ben only')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Failed -- tap to retry' }),
    ).not.toBeInTheDocument();
    // The composer should also be empty rather than carrying the other conversation's draft.
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('renders message bodies as plain text with safe links', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse([message({ body: 'see https://example.com/docs for details' })]),
      }),
    );
    renderApp(`/c/${conversationId}`);
    const link = await screen.findByRole('link', { name: 'https://example.com/docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/see/)).toBeInTheDocument();
    expect(screen.getByText(/for details/)).toBeInTheDocument();
  });

  it('shows a character counter once close to the 4,000 character limit', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([]),
      }),
    );
    renderApp(`/c/${conversationId}`);
    const textarea = await screen.findByLabelText('Message');

    fireEvent.change(textarea, { target: { value: 'short' } });
    expect(screen.queryByText('3995')).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'x'.repeat(3850) } });
    expect(await screen.findByText('150')).toBeInTheDocument();
  });

  it('shows a message delivered live over the realtime connection without a page reload', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([]),
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByLabelText('Message');

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    const incoming = message({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      senderId: peer.id,
      body: 'delivered live',
    });
    socket.emit('message', {
      data: JSON.stringify(makeEnvelope('message.new', incoming, incoming.id)),
    });

    expect(await screen.findByText('delivered live')).toBeInTheDocument();
  });

  it('does not clear a pending bubble because another member happened to reuse its clientMsgId', async () => {
    // clientMsgId is only unique per sender (the server dedupes on (senderId, clientMsgId)), so
    // force our own pending send and the peer's incoming message to share one and confirm the
    // realtime handler still tells them apart by sender.
    const randomUUID = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('66666666-6666-4666-8666-666666666666' as never);
    try {
      const neverResolves = new Promise<Response>(() => {});
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () => jsonResponse([]),
          [`POST /conversations/${conversationId}/messages`]: () => neverResolves,
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByLabelText('Message');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');

      await userEvent.type(screen.getByLabelText('Message'), 'my pending message');
      await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(screen.getByText('Sending…')).toBeInTheDocument();

      const fromPeer = message({
        senderId: peer.id,
        clientMsgId: '66666666-6666-4666-8666-666666666666',
        body: 'from ben',
      });
      socket.emit('message', {
        data: JSON.stringify(makeEnvelope('message.new', fromPeer, fromPeer.id)),
      });

      await screen.findByText('from ben');
      expect(screen.getByText('Sending…')).toBeInTheDocument();
      expect(screen.getByText('my pending message')).toBeInTheDocument();
    } finally {
      // In a `finally`, not just at the end of the happy path: if an assertion above throws, the
      // spy would otherwise leak into later tests (there's no global `restoreMocks` configured).
      randomUUID.mockRestore();
    }
  });
});

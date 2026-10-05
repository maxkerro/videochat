import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeEnvelope, type MessageType } from '@videochat/shared';
import { ApiError } from '../../lib/api';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';
import { buildRows, classifySendFailure, failureLabelFor, shouldRetryQuery } from './ChatPane';

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

function conversation(overrides: Partial<{ lastSeq: number; lastReadSeq: number }> = {}) {
  return {
    id: conversationId,
    type: 'direct' as const,
    title: null,
    lastSeq: 1,
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    role: 'member' as const,
    lastReadSeq: 1,
    peer,
    ...overrides,
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
    conversationId: conversationId as string,
    seq: 1,
    senderId: peer.id as string | null,
    clientMsgId: null as string | null,
    type: 'text' as MessageType,
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

/** A minimal fake of the browser WebSocket (mirrors lib/realtime.test.ts's), used here to drive
 *  RealtimeProvider's connection from the outside and simulate a `message.new` arriving live. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly OPEN = 1;
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  readyState = 0;
  /** CHAT-020: records every client->server send (e.g. a typing signal), so a test can assert on
   *  what actually went out over the socket. */
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event?: unknown) => void) {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  emit(type: string, event?: unknown) {
    // CHAT-020: RealtimeClient.send() gates on `readyState === OPEN` -- without this, `open`
    // events simulated in existing tests would leave the fake socket looking permanently closed
    // to that check, so an outbound-send test could never pass.
    if (type === 'open') this.readyState = 1;
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

describe('classifySendFailure (CHAT-021)', () => {
  it('classifies a 429 as rate-limited', () => {
    expect(classifySendFailure(new ApiError(429, 'slow down'))).toBe('rate-limited');
  });

  it('classifies a 403 as blocked', () => {
    expect(classifySendFailure(new ApiError(403, 'forbidden'))).toBe('blocked');
  });

  it('classifies anything else (a 404, a 500, a network error) as other', () => {
    expect(classifySendFailure(new ApiError(404, 'not found'))).toBe('other');
    expect(classifySendFailure(new ApiError(500, 'server error'))).toBe('other');
    expect(classifySendFailure(new TypeError('Failed to fetch'))).toBe('other');
  });
});

describe('failureLabelFor (CHAT-021)', () => {
  it('gives a distinguishable message per reason, always ending in "tap to retry"', () => {
    expect(failureLabelFor('rate-limited')).toMatch(/too fast/);
    expect(failureLabelFor('rate-limited')).toMatch(/tap to retry$/);
    expect(failureLabelFor('blocked')).toMatch(/tap to retry$/);
    expect(failureLabelFor(undefined)).toBe('Failed -- tap to retry');
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
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
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
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [message()], hasMore: false }),
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
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
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

  it('CHAT-021: shows a distinct "sending too fast" message for a 429 from the send endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /users/blocked`]: () => jsonResponse({ users: [] }),
        [`POST /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ message: 'slow down' }, 429),
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'too many messages');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await screen.findByText(/sending messages too fast/i);
  });

  it('CHAT-021: shows a distinct "couldn\'t be delivered" message for a 403 from the send endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`GET /users/blocked`]: () => jsonResponse({ users: [] }),
        [`POST /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ message: 'blocked' }, 403),
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'are you there');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await screen.findByText(/couldn't be delivered/i);
  });

  it('does not leak a failed send into a conversation switched to afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
        [`POST /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ message: 'Server error' }, 500),
        [`GET /conversations/${otherConversationId}`]: () => jsonResponse(otherConversation()),
        [`GET /conversations/${otherConversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
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
          jsonResponse({
            messages: [message({ body: 'see https://example.com/docs for details' })],
            hasMore: false,
          }),
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
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
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
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
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
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
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

  it('loads an older page of history once scrolled near the oldest loaded message', async () => {
    let sawBefore: string | null = null;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: (url) => {
          const before = url.searchParams.get('before');
          sawBefore = before;
          if (!before) {
            return jsonResponse({
              messages: [
                message({ id: 'C'.repeat(26), seq: 3, body: 'msg three' }),
                message({ id: 'D'.repeat(26), seq: 4, body: 'msg four' }),
              ],
              hasMore: true,
            });
          }
          return jsonResponse({
            messages: [message({ id: 'A'.repeat(26), seq: 1, body: 'msg one' })],
            hasMore: false,
          });
        },
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByText('msg three');
    expect(sawBefore).toBeNull();

    const list = screen.getByRole('list', { name: 'Messages' });
    // jsdom does no real layout -- scrollHeight/clientHeight/scrollTop are 0 by default, so a
    // scroll near the oldest (DOM-bottom, since the list is flipped -- see ChatPane.tsx) end has
    // to be faked directly on this element rather than by actually scrolling it.
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 550, configurable: true, writable: true });
    fireEvent.scroll(list);

    await waitFor(() => expect(sawBefore).toBe('3'));
    expect(await screen.findByText('msg one')).toBeInTheDocument();
  });

  it('shows a growing "new messages" count instead of auto-jumping while scrolled away from the latest message', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByLabelText('Message');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');

    const list = screen.getByRole('list', { name: 'Messages' });
    Object.defineProperty(list, 'scrollTop', { value: 300, configurable: true, writable: true });
    fireEvent.scroll(list);

    const first = message({ id: 'E'.repeat(26), senderId: peer.id, body: 'while scrolled away' });
    socket.emit('message', { data: JSON.stringify(makeEnvelope('message.new', first, first.id)) });
    expect(await screen.findByRole('button', { name: '1 new message ↓' })).toBeInTheDocument();

    const second = message({ id: 'F'.repeat(26), senderId: peer.id, body: 'another one' });
    socket.emit('message', {
      data: JSON.stringify(makeEnvelope('message.new', second, second.id)),
    });
    expect(await screen.findByRole('button', { name: '2 new messages ↓' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '2 new messages ↓' }));
    expect(screen.queryByRole('button', { name: /new message/ })).not.toBeInTheDocument();
  });

  it('shows a "New messages" divider before the first unread message when opening a conversation with unread history', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () =>
          jsonResponse(conversation({ lastReadSeq: 1 })),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({
            messages: [
              message({ id: 'A'.repeat(26), seq: 1, body: 'already read' }),
              message({ id: 'B'.repeat(26), seq: 2, body: 'first unread' }),
            ],
            hasMore: false,
          }),
      }),
    );
    renderApp(`/c/${conversationId}`);
    expect(await screen.findByText('first unread')).toBeInTheDocument();
    expect(screen.getByLabelText('New messages')).toBeInTheDocument();
  });

  it('shows no "New messages" divider when the conversation is already fully read', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () =>
          jsonResponse(conversation({ lastReadSeq: 1 })),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [message({ seq: 1 })], hasMore: false }),
      }),
    );
    renderApp(`/c/${conversationId}`);
    await screen.findByText('Hi there');
    expect(screen.queryByLabelText('New messages')).not.toBeInTheDocument();
  });

  describe('CHAT-030 attachments', () => {
    const attachment = {
      id: '66666666-6666-4666-8666-666666666666',
      kind: 'file' as const,
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2_500_000,
      width: null,
      height: null,
    };

    it('renders a file message with its name, size and caption', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({
              messages: [message({ type: 'file', body: 'Q3 numbers', attachment } as never)],
              hasMore: false,
            }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      expect(await screen.findByText('report.pdf')).toBeInTheDocument();
      expect(screen.getByText('2.4 MB')).toBeInTheDocument();
      expect(screen.getByText('Q3 numbers')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download report.pdf' })).toBeInTheDocument();
    });

    it('refuses a file over the size limit before uploading anything', async () => {
      const fetchMock = routedFetch({
        'POST /auth/refresh': () => jsonResponse(session()),
        [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
        [`GET /conversations/${conversationId}/messages`]: () =>
          jsonResponse({ messages: [], hasMore: false }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderApp(`/c/${conversationId}`);
      await screen.findByRole('heading', { name: 'Ben Okafor' });
      const big = new File(['x'], 'huge.zip', { type: 'application/zip' });
      Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
      fireEvent.change(screen.getByTestId('attachment-input'), { target: { files: [big] } });
      expect(await screen.findByText(/huge.zip is too big/)).toBeInTheDocument();
      expect(
        vi.mocked(fetchMock).mock.calls.some(([u]) => String(u).includes('/attachments')),
      ).toBe(false);
    });
  });

  describe('CHAT-031 link previews', () => {
    const preview = {
      url: 'https://example.com/post',
      title: 'A great post',
      description: 'All about it',
      siteName: 'Example',
      imageUrl: null,
    };

    it('adds a preview to a shown message when message.updated arrives', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({
              messages: [message({ body: 'see https://example.com/post' })],
              hasMore: false,
            }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByText('https://example.com/post');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');
      const updated = {
        ...message({ body: 'see https://example.com/post' }),
        linkPreview: preview,
      };
      socket.emit('message', {
        data: JSON.stringify(makeEnvelope('message.updated', updated, 'evt-1')),
      });
      expect(await screen.findByRole('link', { name: 'A great post' })).toBeInTheDocument();
      // Ben's message: Anna can't remove its preview.
      expect(screen.queryByRole('button', { name: 'Remove link preview' })).not.toBeInTheDocument();
    });

    it('shows a preview while typing and sends linkPreview: false once dismissed', async () => {
      let sentBody: Record<string, unknown> | undefined;
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
          'GET /link-preview': () => jsonResponse({ preview }),
          [`POST /conversations/${conversationId}/messages`]: (_url, init) => {
            sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return jsonResponse(
              message({
                id: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
                senderId: baseUser.id,
                body: 'https://example.com/post',
              }),
            );
          },
        }),
      );
      renderApp(`/c/${conversationId}`);
      await userEvent.type(await screen.findByLabelText('Message'), 'https://example.com/post');
      expect(
        await screen.findByRole('link', { name: 'A great post' }, { timeout: 3000 }),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Don’t include a link preview' }));
      expect(screen.queryByRole('link', { name: 'A great post' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(sentBody).toMatchObject({ linkPreview: false }));
    });
  });

  describe('CHAT-018 groups', () => {
    const groupId = '77777777-7777-4777-8777-777777777777';

    function groupConversation() {
      return {
        id: groupId,
        type: 'group' as const,
        title: 'Weekend trip',
        lastSeq: 1,
        lastMessageAt: '2026-01-01T10:00:00.000Z',
        role: 'admin' as const,
        lastReadSeq: 1,
        peer: null,
      };
    }

    it('renders a system message distinctly, with no bubble or own/other styling', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
          [`GET /conversations/${groupId}/messages`]: () =>
            jsonResponse({
              messages: [
                message({
                  id: 'S'.repeat(26),
                  conversationId: groupId,
                  senderId: null,
                  type: 'system',
                  body: 'Anna created the group',
                }),
              ],
              hasMore: false,
            }),
        }),
      );
      renderApp(`/c/${groupId}`);

      const system = await screen.findByText('Anna created the group');
      // Not inside a `.message`-classed bubble row -- a system message has no sender bubble.
      expect(system.closest('[class*="bubble"]')).not.toBeInTheDocument();
    });

    it('shows a "Members" button only for a group conversation, opening the members panel', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
          [`GET /conversations/${groupId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
          [`GET /conversations/${groupId}/members`]: () =>
            jsonResponse([
              {
                userId: baseUser.id,
                username: baseUser.username,
                displayName: baseUser.displayName,
                avatarUrl: null,
                role: 'admin',
                joinedAt: '2026-01-01T00:00:00.000Z',
              },
              {
                userId: peer.id,
                username: peer.username,
                displayName: peer.displayName,
                avatarUrl: null,
                role: 'member',
                joinedAt: '2026-01-02T00:00:00.000Z',
              },
            ]),
        }),
      );
      renderApp(`/c/${groupId}`);
      await screen.findByRole('heading', { name: 'Weekend trip' });

      await userEvent.click(screen.getByRole('button', { name: 'Members' }));
      expect(await screen.findByRole('dialog', { name: 'Group members' })).toBeInTheDocument();
      expect(await screen.findByText('Ben Okafor')).toBeInTheDocument();
      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('member')).toBeInTheDocument();
    });

    it('does not show a "Members" button for a direct conversation', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByRole('heading', { name: 'Ben Okafor' });
      expect(screen.queryByRole('button', { name: 'Members' })).not.toBeInTheDocument();
    });
  });

  describe('CHAT-021 blocking', () => {
    const groupId = '88888888-8888-4888-8888-888888888888';

    function groupConversation() {
      return {
        id: groupId,
        type: 'group' as const,
        title: 'Weekend trip',
        lastSeq: 0,
        lastMessageAt: null,
        role: 'admin' as const,
        lastReadSeq: 0,
        peer: null,
      };
    }

    it('offers "Block" for a direct conversation whose peer is not yet blocked', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
          [`GET /users/blocked`]: () => jsonResponse({ users: [] }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByRole('heading', { name: 'Ben Okafor' });

      await userEvent.click(screen.getByRole('button', { name: `More options for Ben Okafor` }));
      expect(await screen.findByText('Block Ben Okafor')).toBeInTheDocument();
    });

    it('offers "Unblock" instead when the peer is already in the blocklist', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
          [`GET /users/blocked`]: () => jsonResponse({ users: [peer] }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByRole('heading', { name: 'Ben Okafor' });

      await userEvent.click(screen.getByRole('button', { name: `More options for Ben Okafor` }));
      expect(await screen.findByText('Unblock Ben Okafor')).toBeInTheDocument();
    });

    it('does not offer a block/unblock menu for a group conversation', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
          [`GET /conversations/${groupId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
          [`GET /conversations/${groupId}/members`]: () => jsonResponse([]),
        }),
      );
      renderApp(`/c/${groupId}`);
      await screen.findByRole('heading', { name: 'Weekend trip' });
      expect(screen.queryByRole('button', { name: /More options for/ })).not.toBeInTheDocument();
    });
  });

  describe('CHAT-020 typing indicators', () => {
    function typingEnvelope(
      userId: string,
      displayName: string,
      forConversationId = conversationId,
    ) {
      return makeEnvelope(
        'conversation.typing',
        { conversationId: forConversationId, userId, displayName },
        `typing-${userId}`,
      );
    }

    it('sends a throttled typing signal over the socket as the person types', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      const textarea = await screen.findByLabelText('Message');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');

      fireEvent.change(textarea, { target: { value: 'h' } });
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.change(textarea, { target: { value: 'hi there' } });

      // Leading-edge throttle: several keystrokes in quick succession only ever send once.
      const typingSends = socket.sent.filter(
        (raw) => JSON.parse(raw).type === 'conversation.typing',
      );
      expect(typingSends).toHaveLength(1);
      expect(JSON.parse(typingSends[0]!).payload).toEqual({ conversationId });
    });

    it('does not send a typing signal for an empty composer', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      const textarea = await screen.findByLabelText('Message');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');

      fireEvent.change(textarea, { target: { value: 'draft' } });
      fireEvent.change(textarea, { target: { value: '' } });

      const typingSends = socket.sent.filter(
        (raw) => JSON.parse(raw).type === 'conversation.typing',
      );
      expect(typingSends).toHaveLength(1); // only from the one non-empty change above
    });

    it('shows "<name> is typing…" when a single other member\'s signal arrives', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByLabelText('Message');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');

      socket.emit('message', { data: JSON.stringify(typingEnvelope(peer.id, peer.displayName)) });

      expect(await screen.findByText('Ben Okafor is typing…')).toBeInTheDocument();
    });

    it("never shows an indicator for the signed-in person's own typing signal echoed back", async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByLabelText('Message');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');

      socket.emit('message', {
        data: JSON.stringify(typingEnvelope(baseUser.id, baseUser.displayName)),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByText(/is typing…$/)).not.toBeInTheDocument();
    });

    it('ignores a typing signal for a different conversation than the one open', async () => {
      vi.stubGlobal(
        'fetch',
        routedFetch({
          'POST /auth/refresh': () => jsonResponse(session()),
          [`GET /conversations/${conversationId}`]: () => jsonResponse(conversation()),
          [`GET /conversations/${conversationId}/messages`]: () =>
            jsonResponse({ messages: [], hasMore: false }),
        }),
      );
      renderApp(`/c/${conversationId}`);
      await screen.findByLabelText('Message');
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      socket.emit('open');

      socket.emit('message', {
        data: JSON.stringify(typingEnvelope(peer.id, peer.displayName, otherConversationId)),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByText(/is typing…$/)).not.toBeInTheDocument();
    });

    describe('group name-count thresholds', () => {
      const groupId = '88888888-8888-4888-8888-888888888888';
      const memberA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Anna' };
      const memberB = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Ben' };
      const memberC = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'Cara' };
      const memberD = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', displayName: 'Dev' };

      function groupConversation() {
        return {
          id: groupId,
          type: 'group' as const,
          title: 'Team chat',
          lastSeq: 0,
          lastMessageAt: null,
          role: 'member' as const,
          lastReadSeq: 0,
          peer: null,
        };
      }

      async function openGroup() {
        vi.stubGlobal(
          'fetch',
          routedFetch({
            'POST /auth/refresh': () => jsonResponse(session()),
            [`GET /conversations/${groupId}`]: () => jsonResponse(groupConversation()),
            [`GET /conversations/${groupId}/messages`]: () =>
              jsonResponse({ messages: [], hasMore: false }),
          }),
        );
        renderApp(`/c/${groupId}`);
        await screen.findByRole('heading', { name: 'Team chat' });
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        socket.emit('open');
        return socket;
      }

      it('names up to 3 concurrent typers, joined naturally', async () => {
        const socket = await openGroup();

        socket.emit('message', {
          data: JSON.stringify(typingEnvelope(memberA.id, memberA.displayName, groupId)),
        });
        expect(await screen.findByText('Anna is typing…')).toBeInTheDocument();

        socket.emit('message', {
          data: JSON.stringify(typingEnvelope(memberB.id, memberB.displayName, groupId)),
        });
        expect(await screen.findByText('Anna and Ben are typing…')).toBeInTheDocument();

        socket.emit('message', {
          data: JSON.stringify(typingEnvelope(memberC.id, memberC.displayName, groupId)),
        });
        expect(await screen.findByText('Anna, Ben and Cara are typing…')).toBeInTheDocument();
      });

      it('collapses to "Several people are typing…" once a 4th person joins in', async () => {
        const socket = await openGroup();

        for (const m of [memberA, memberB, memberC, memberD]) {
          socket.emit('message', {
            data: JSON.stringify(typingEnvelope(m.id, m.displayName, groupId)),
          });
        }

        expect(await screen.findByText('Several people are typing…')).toBeInTheDocument();
      });
    });
  });
});

describe('buildRows', () => {
  it('inserts a day separator before the first message of each new calendar day', () => {
    const rows = buildRows(
      [
        message({ id: 'A'.repeat(26), seq: 1, createdAt: '2026-01-01T10:00:00.000Z' }),
        message({ id: 'B'.repeat(26), seq: 2, createdAt: '2026-01-02T09:00:00.000Z' }),
      ],
      [],
      null,
    );
    expect(rows.map((r) => r.kind)).toEqual(['day', 'message', 'day', 'message']);
  });

  it('groups consecutive messages from the same sender within a minute, breaking on a sender change or a gap', () => {
    const rows = buildRows(
      [
        message({
          id: 'A'.repeat(26),
          seq: 1,
          senderId: peer.id,
          createdAt: '2026-01-01T10:00:00.000Z',
        }),
        message({
          id: 'B'.repeat(26),
          seq: 2,
          senderId: peer.id,
          createdAt: '2026-01-01T10:00:30.000Z',
        }),
        message({
          id: 'C'.repeat(26),
          seq: 3,
          senderId: baseUser.id,
          createdAt: '2026-01-01T10:00:40.000Z',
        }),
        message({
          id: 'D'.repeat(26),
          seq: 4,
          senderId: peer.id,
          createdAt: '2026-01-01T10:05:00.000Z',
        }),
      ],
      [],
      null,
    );
    const grouped = rows
      .filter((r): r is Extract<(typeof rows)[number], { kind: 'message' }> => r.kind === 'message')
      .map((r) => r.grouped);
    expect(grouped).toEqual([false, true, false, false]);
  });

  it('places the "New messages" divider right before the first message past the captured unread cursor', () => {
    const rows = buildRows(
      [
        message({ id: 'A'.repeat(26), seq: 1 }),
        message({ id: 'B'.repeat(26), seq: 2 }),
        message({ id: 'C'.repeat(26), seq: 3 }),
      ],
      [],
      1,
    );
    expect(rows.map((r) => r.kind)).toEqual(['day', 'message', 'unread', 'message', 'message']);
  });

  it('adds no unread divider when there is nothing unread', () => {
    const messages = [
      message({ id: 'A'.repeat(26), seq: 1 }),
      message({ id: 'B'.repeat(26), seq: 2 }),
    ];
    expect(buildRows(messages, [], null).some((r) => r.kind === 'unread')).toBe(false);
    expect(buildRows(messages, [], 2).some((r) => r.kind === 'unread')).toBe(false);
  });

  it('appends pending (optimistic) sends after every real message', () => {
    const rows = buildRows(
      [message({ id: 'A'.repeat(26), seq: 1 })],
      [{ clientMsgId: 'c-1', conversationId: 'conv-1', body: 'hi', status: 'sending' }],
      null,
    );
    expect(rows.map((r) => r.kind)).toEqual(['day', 'message', 'pending']);
  });
});

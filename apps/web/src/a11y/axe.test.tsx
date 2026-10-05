import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { jsonResponse } from '../test/mockFetch';
import { renderApp } from '../test/renderApp';

/**
 * CHAT-038 AC: "No critical axe violations on any screen." Every main screen is rendered and
 * checked with axe-core. Colour contrast can't be measured in jsdom (no layout or computed
 * colours), so it's checked separately against the design tokens (contrast.test.ts); everything
 * else axe knows about is checked here, and serious violations fail too, not only critical.
 */
async function violations(): Promise<axe.Result[]> {
  const result = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

function describeViolations(list: axe.Result[]): string {
  return list
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
    .join('\n');
}

const user = {
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
const conversation = {
  id: conversationId,
  type: 'direct',
  title: null,
  lastSeq: 3,
  lastMessageAt: '2026-01-01T10:02:00.000Z',
  role: 'member',
  lastReadSeq: 3,
  peer,
  peerLastReadSeq: 3,
  muted: false,
  lastMessage: { type: 'text', senderId: peer.id, body: 'See you' },
};
const base = {
  conversationId,
  clientMsgId: null,
  replyToId: null,
  editedAt: null,
  deletedAt: null,
};
const messages = [
  {
    ...base,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    seq: 1,
    senderId: peer.id,
    type: 'text',
    body: 'Lunch at 12? https://example.com',
    createdAt: '2026-01-01T10:00:00.000Z',
    reactions: [{ emoji: '👍', count: 1, userIds: [user.id] }],
    linkPreview: {
      url: 'https://example.com',
      title: 'Example',
      description: null,
      siteName: null,
      imageUrl: null,
    },
  },
  {
    ...base,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
    seq: 2,
    senderId: user.id,
    type: 'file',
    body: null,
    createdAt: '2026-01-01T10:01:00.000Z',
    attachment: {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'file',
      filename: 'menu.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
      width: null,
      height: null,
    },
  },
  {
    ...base,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
    seq: 3,
    senderId: peer.id,
    type: 'text',
    body: 'See you',
    replyToId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    replyTo: {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      seq: 1,
      senderId: peer.id,
      type: 'text',
      snippet: 'Lunch at 12?',
      deleted: false,
    },
    createdAt: '2026-01-01T10:02:00.000Z',
  },
];

function signedInFetch(): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const table: Record<string, unknown> = {
      'POST /auth/refresh': {
        accessToken: 't',
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        user,
      },
      'GET /conversations': [conversation],
      [`GET /conversations/${conversationId}`]: conversation,
      [`GET /conversations/${conversationId}/messages`]: { messages, hasMore: false },
      'GET /users/blocked': { users: [] },
      'GET /presence': [],
    };
    if (route in table) return Promise.resolve(jsonResponse(table[route]));
    return Promise.resolve(jsonResponse({ message: 'not found' }, 404));
  }) as unknown as typeof fetch;
}

class FakeWebSocket {
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

describe('accessibility (CHAT-038)', () => {
  beforeEach(() => vi.stubGlobal('WebSocket', FakeWebSocket));
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['/login', 'Log in'],
    ['/signup', 'Create your account'],
    ['/forgot-password', 'Reset your password'],
  ])('%s has no serious or critical violations', async (path, heading) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'no' }, 401))),
    );
    renderApp(path);
    await screen.findByRole('heading', { level: 1, name: new RegExp(heading, 'i') });
    const found = await violations();
    expect(found, describeViolations(found)).toEqual([]);
  });

  it('the inbox and an open conversation have no serious or critical violations', async () => {
    vi.stubGlobal('fetch', signedInFetch());
    renderApp(`/c/${conversationId}`);
    await screen.findByText('menu.pdf');
    await screen.findAllByText('See you');
    const found = await violations();
    expect(found, describeViolations(found)).toEqual([]);
  });

  it('settings has no serious or critical violations', async () => {
    vi.stubGlobal('fetch', signedInFetch());
    renderApp('/settings');
    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Read receipts/ })).toBeInTheDocument(),
    );
    const found = await violations();
    expect(found, describeViolations(found)).toEqual([]);
  });
});

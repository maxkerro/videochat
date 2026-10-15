import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SEARCH_MARK_END, SEARCH_MARK_START } from '@videochat/shared';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

const me = {
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
const benChat = '33333333-3333-4333-8333-333333333333';

const conversations = [
  {
    id: benChat,
    type: 'direct' as const,
    title: null,
    lastSeq: 5,
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    role: 'member' as const,
    lastReadSeq: 5,
    peer: ben,
  },
];

function hit(id: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    message: {
      id,
      conversationId: benChat,
      seq: 2,
      senderId: ben.id,
      clientMsgId: null,
      type: 'text',
      body,
      replyToId: null,
      editedAt: null,
      deletedAt: null,
      createdAt: '2026-01-01T09:00:00.000Z',
      ...extra,
    },
    senderName: 'Ben Okafor',
    snippet: body.replace('budget', `${SEARCH_MARK_START}budget${SEARCH_MARK_END}`),
  };
}

function setup(onSearch: (url: URL) => unknown) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (route === 'POST /auth/refresh')
      return Promise.resolve(
        jsonResponse({
          accessToken: 't',
          accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
          user: me,
        }),
      );
    if (route === 'GET /conversations') return Promise.resolve(jsonResponse(conversations));
    if (route === 'GET /search') return Promise.resolve(jsonResponse(onSearch(url)));
    if (route === `GET /conversations/${benChat}`)
      return Promise.resolve(jsonResponse(conversations[0]));
    if (route === `GET /conversations/${benChat}/messages`)
      return Promise.resolve(jsonResponse({ messages: [], hasMore: false }));
    throw new Error(`Unhandled request: ${route}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => vi.unstubAllGlobals());

describe('MessageSearch (CHAT-072)', () => {
  it('searches messages after two characters, highlights matches and opens a result at that message', async () => {
    const seen: URL[] = [];
    setup((url) => {
      seen.push(url);
      return { results: [hit('A'.repeat(26), 'The budget is final')], nextCursor: null };
    });
    const { router } = renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });
    const input = screen.getByLabelText('Search conversations and messages');
    await userEvent.type(input, 'b');
    expect(screen.queryByRole('region', { name: 'Message search' })).not.toBeInTheDocument();
    await userEvent.type(input, 'udg');

    const region = await screen.findByRole('region', { name: 'Message search' });
    const mark = await within(region).findByText('budget');
    expect(mark.tagName).toBe('MARK');
    expect(seen.at(-1)?.searchParams.get('q')).toBe('budg');

    await userEvent.click(within(region).getByRole('button', { name: /The budget is final/ }));
    expect(router.state.location.pathname).toBe(`/c/${benChat}`);
  });

  it('sends the chosen filters and shows the attachment name', async () => {
    const seen: URL[] = [];
    setup((url) => {
      seen.push(url);
      return {
        results: [
          hit('B'.repeat(26), 'budget.pdf', {
            type: 'file',
            attachment: {
              id: '66666666-6666-4666-8666-666666666666',
              kind: 'file',
              filename: 'budget.pdf',
              contentType: 'application/pdf',
              sizeBytes: 1000,
              width: null,
              height: null,
            },
          }),
        ],
        nextCursor: null,
      };
    });
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });
    await userEvent.type(screen.getByLabelText('Search conversations and messages'), 'budget');
    const region = await screen.findByRole('region', { name: 'Message search' });
    await userEvent.selectOptions(within(region).getByLabelText('In'), benChat);
    await userEvent.selectOptions(within(region).getByLabelText('From'), ben.id);
    await userEvent.selectOptions(within(region).getByLabelText('Has'), 'file');
    await userEvent.selectOptions(within(region).getByLabelText('Date'), 'week');
    await waitFor(() => {
      const params = seen.at(-1)!.searchParams;
      expect(params.get('conversationId')).toBe(benChat);
      expect(params.get('from')).toBe(ben.id);
      expect(params.get('has')).toBe('file');
      expect(params.get('after')).toMatch(/^\d{4}-/);
    });
    expect(await within(region).findByText(/📎 budget\.pdf/)).toBeInTheDocument();
  });

  it('says when nothing matches, and offers more results when there is a next page', async () => {
    setup((url) =>
      url.searchParams.get('q') === 'zzz'
        ? { results: [], nextCursor: null }
        : { results: [hit('C'.repeat(26), 'budget one')], nextCursor: 'next' },
    );
    renderApp('/');
    await screen.findByRole('link', { name: /Ben Okafor/ });
    const input = screen.getByLabelText('Search conversations and messages');
    await userEvent.type(input, 'zzz');
    expect(await screen.findByText('No messages match “zzz”.')).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'budget');
    expect(await screen.findByRole('button', { name: 'More results' })).toBeInTheDocument();
  });
});

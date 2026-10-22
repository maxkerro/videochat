import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

const mod = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'mod',
  displayName: 'Mo Derator',
  avatarUrl: null,
  email: 'mod@example.com',
  emailVerified: true,
  moderator: true,
};
const person = (id: string, name: string) => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  deleted: false,
  suspendedUntil: null,
  bannedAt: null,
});
const ben = person('00000000-0000-4000-8000-0000000000b0', 'Ben');
const anna = person('00000000-0000-4000-8000-0000000000a0', 'Anna');
const report = {
  id: '00000000-0000-4000-8000-0000000000c1',
  kind: 'message',
  status: 'open',
  reason: 'harassment',
  details: 'keeps doing this',
  createdAt: '2026-10-17T10:00:00.000Z',
  reporter: anna,
  reportedUser: ben,
  conversationId: '00000000-0000-4000-8000-0000000000d0',
  messageId: '01J0000000000000000000000B',
  openReportsAboutUser: 2,
  resolution: null,
};
const msg = (n: number, reported = false) => ({
  id: `01J00000000000000000000${String(n).padStart(3, '0')}`,
  seq: n,
  senderId: ben.id,
  senderName: 'Ben',
  type: 'text',
  text: `message ${n}`,
  attachmentName: null,
  encrypted: false,
  deleted: false,
  createdAt: '2026-10-17T09:00:00.000Z',
  reported,
});

function routed(handlers: Record<string, (url: URL, init?: RequestInit) => Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unhandled request: ${key}`);
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof fetch;
}

const session = (user: object) => ({
  accessToken: 'token-1',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  user,
});

afterEach(() => vi.unstubAllGlobals());

describe('ModerationPage (CHAT-077)', () => {
  it('works the queue: opens a report with its context and suspends the person', async () => {
    const resolve = vi.fn((_url: URL, _init?: RequestInit) =>
      jsonResponse({
        ...report,
        status: 'resolved',
        resolution: {
          action: 'suspend',
          note: null,
          by: person(mod.id, 'Mo'),
          at: report.createdAt,
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      routed({
        'POST /auth/refresh': () => jsonResponse(session(mod)),
        'GET /moderation/reports': (url) =>
          jsonResponse({
            reports: url.searchParams.get('status') === 'open' ? [report] : [],
            nextCursor: null,
          }),
        [`GET /moderation/reports/${report.id}`]: () =>
          jsonResponse({
            ...report,
            snapshot: { text: 'message 2', fromReporter: false },
            context: [msg(1), msg(2, true), msg(3)],
          }),
        [`POST /moderation/reports/${report.id}/resolve`]: resolve,
      }),
    );
    renderApp('/moderate');
    const list = await screen.findByRole('list', { name: 'open reports' });
    expect(within(list).getByText('2 open')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: /Harassment/ }));

    const view = await screen.findByRole('region', { name: 'Report' });
    expect(within(view).getByText('keeps doing this')).toBeInTheDocument();
    expect(within(view).getAllByText('message 2')).toHaveLength(2); // snapshot + context
    expect(within(view).getByText('message 3')).toBeInTheDocument();

    await userEvent.click(within(view).getByRole('radio', { name: /Suspend/ }));
    const days = within(view).getByRole('spinbutton', { name: 'Days' });
    await userEvent.clear(days);
    await userEvent.type(days, '3');
    await userEvent.type(within(view).getByRole('textbox'), 'second strike');
    await userEvent.click(within(view).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(JSON.parse(String(resolve.mock.calls[0]![1]!.body))).toEqual({
      action: 'suspend',
      days: 3,
      note: 'second strike',
    });
  });

  it('turns away people who aren’t moderators', async () => {
    vi.stubGlobal(
      'fetch',
      routed({ 'POST /auth/refresh': () => jsonResponse(session({ ...mod, moderator: false })) }),
    );
    renderApp('/moderate');
    expect(await screen.findByText('This page is for moderators.')).toBeInTheDocument();
  });

  it('shows the audit log', async () => {
    vi.stubGlobal(
      'fetch',
      routed({
        'POST /auth/refresh': () => jsonResponse(session(mod)),
        'GET /moderation/reports': () => jsonResponse({ reports: [], nextCursor: null }),
        'GET /moderation/audit': () =>
          jsonResponse({
            entries: [
              {
                id: '00000000-0000-4000-8000-0000000000e1',
                action: 'suspend',
                moderator: person(mod.id, 'Mo'),
                targetUser: ben,
                reportId: report.id,
                note: 'second strike',
                details: { days: 3 },
                createdAt: report.createdAt,
              },
            ],
            nextCursor: null,
          }),
      }),
    );
    renderApp('/moderate');
    await userEvent.click(await screen.findByRole('tab', { name: 'Audit log' }));
    expect(await screen.findByText('Suspended (3 days)')).toBeInTheDocument();
    expect(screen.getByText('second strike')).toBeInTheDocument();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/renderApp';

const health = {
  status: 'ok',
  version: 'test',
  uptimeSeconds: 5,
  checks: { database: 'up', redis: 'up' },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(health), { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('App shell', () => {
  it('shows the conversation list and an empty chat pane', async () => {
    renderApp('/');
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Select a conversation' })).toBeInTheDocument();
    // Shared-contract path: web → /health → healthResponseSchema.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
  });

  it('opens a conversation from the list', async () => {
    const { router } = renderApp('/');
    await userEvent.click(screen.getByRole('link', { name: /Ben Okafor/ }));
    expect(router.state.location.pathname).toBe('/c/dm-ben');
    expect(screen.getByRole('heading', { name: 'Ben Okafor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });

  it('filters conversations by search', async () => {
    renderApp('/');
    await userEvent.type(screen.getByLabelText('Search conversations'), 'clara');
    expect(screen.getByRole('link', { name: /Clara Novak/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ben Okafor/ })).not.toBeInTheDocument();
  });

  it('opens the new chat dialog and closes it with Escape', async () => {
    renderApp('/');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('dialog', { name: 'New chat' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the new chat dialog on Cancel, without submitting', async () => {
    renderApp('/');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the new chat dialog on Start chat and shows the "coming soon" toast', async () => {
    renderApp('/');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Coming in M1')).toBeInTheDocument();
    expect(screen.getByText('Finding people arrives with CHAT-012.')).toBeInTheDocument();
  });

  it('shows an empty state and hides non-matching conversations when a search matches nothing', async () => {
    renderApp('/');
    await userEvent.type(screen.getByLabelText('Search conversations'), 'nobody-has-this-name');
    expect(screen.getByText('No conversations match “nobody-has-this-name”.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ben Okafor/ })).not.toBeInTheDocument();
  });

  it('shows an unread badge on conversations with unread messages, and none on read ones', async () => {
    renderApp('/');
    const projectLink = screen.getByRole('link', { name: /Project Relay/ });
    expect(within(projectLink).getByLabelText('2 unread')).toBeInTheDocument();
    const benLink = screen.getByRole('link', { name: /Ben Okafor/ });
    expect(within(benLink).queryByText(/unread/)).not.toBeInTheDocument();
  });

  it('renders the not-found page for an unknown route', async () => {
    renderApp('/this/route/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Go to conversations' }));
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument();
  });

  it('lazy-loads the /ui design system gallery route', async () => {
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

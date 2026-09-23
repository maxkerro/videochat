import { screen, waitFor } from '@testing-library/react';
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

  it('reports when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderApp('/');
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('Can’t reach the server'),
      { timeout: 4000 },
    );
  });
});

import { screen, waitFor } from '@testing-library/react';
import { jsonResponse } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

/** Unlike `test/setup.ts`'s default `NoopWebSocket` (which opens itself on the next microtask so
 *  the rest of the suite doesn't have to think about connection state), this one only opens or
 *  closes when the test tells it to -- letting these tests observe the "connecting" and
 *  "reconnecting" states `NoopWebSocket` normally breezes past. */
class ControllableWebSocket {
  static instances: ControllableWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = ControllableWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: { type: string }) => void>>();

  constructor(public url: string) {
    ControllableWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { type: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: { type: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(): void {
    if (this.readyState === ControllableWebSocket.CLOSED) return;
    this.readyState = ControllableWebSocket.CLOSED;
    this.dispatch('close');
  }

  triggerOpen(): void {
    this.readyState = ControllableWebSocket.OPEN;
    this.dispatch('open');
  }

  private dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type });
  }
}

function session() {
  return {
    accessToken: 'token-1',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'anna',
      displayName: 'Anna Schmidt',
      avatarUrl: null,
      email: 'anna@example.com',
      emailVerified: true,
    },
  };
}

function authedFetch(): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    if (url.pathname === '/auth/refresh') return Promise.resolve(jsonResponse(session()));
    if (url.pathname === '/conversations') return Promise.resolve(jsonResponse([]));
    throw new Error(`Unhandled request: ${init?.method ?? 'GET'} ${url.pathname}`);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  ControllableWebSocket.instances = [];
});

describe('ConnectionStatus (CHAT-017)', () => {
  it('shows Connecting…, then Connected once open, then Reconnecting… after the socket drops', async () => {
    vi.stubGlobal('WebSocket', ControllableWebSocket);
    vi.stubGlobal('fetch', authedFetch());
    renderApp('/');

    await waitFor(() => expect(ControllableWebSocket.instances).toHaveLength(1));
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…');

    ControllableWebSocket.instances[0]!.triggerOpen();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));

    ControllableWebSocket.instances[0]!.close();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…'));
  });

  it('renders nothing when signed out', () => {
    vi.stubGlobal('WebSocket', ControllableWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'no session' }, 401))),
    );
    renderApp('/login');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

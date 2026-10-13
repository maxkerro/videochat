import { makeEnvelope, type WsEnvelope } from '@videochat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real client opens a WebSocket; this one only hands its callbacks to the test.
const hooks = vi.hoisted(() => ({
  onEvent: null as ((e: WsEnvelope) => void) | null,
  onStatus: null as ((s: string) => void) | null,
  sent: [] as WsEnvelope[],
}));
vi.mock('./client', () => ({
  RealtimeClient: class {
    constructor(opts: { onEvent: (e: WsEnvelope) => void; onStatus: (s: string) => void }) {
      hooks.onEvent = opts.onEvent;
      hooks.onStatus = opts.onStatus;
    }
    send(envelope: WsEnvelope) {
      hooks.sent.push(envelope);
      return true;
    }
  },
}));
vi.mock('../lib/api', () => ({
  config: { realtimeUrl: 'ws://test' },
  session: { isSignedIn: () => false, getAccessToken: async () => null },
}));

const { getConnectionId, subscribeRealtime, waitForRealtime } = await import('./connection');

const ready = (connectionId: string) =>
  hooks.onEvent!(makeEnvelope('realtime.ready', { connectionId }, `r-${connectionId}`));

describe('waitForRealtime (CHAT-061 cold-start answer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.onStatus!('closed');
  });
  afterEach(() => vi.useRealTimers());

  it('resolves at once when the socket is already registered', async () => {
    hooks.onStatus!('open');
    ready('c1');
    await expect(waitForRealtime(20_000)).resolves.toBe(true);
  });

  it('resolves when realtime.ready arrives, with the connection id already set', async () => {
    expect(getConnectionId()).toBeNull();
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeRealtime(() => seen.push(getConnectionId()));
    const waiting = waitForRealtime(20_000);
    hooks.onStatus!('open');
    ready('c2');
    await expect(waiting).resolves.toBe(true);
    // Subscribers (the call engine among them) see the id of the socket they are told about.
    expect(seen).toEqual(['c2']);
    unsubscribe();
  });

  it('gives up after the timeout, and stops listening', async () => {
    const waiting = waitForRealtime(20_000);
    vi.advanceTimersByTime(20_000);
    await expect(waiting).resolves.toBe(false);
  });

  it('is not fooled by an open socket the server has not registered yet', async () => {
    hooks.onStatus!('open');
    const waiting = waitForRealtime(20_000);
    vi.advanceTimersByTime(20_000);
    await expect(waiting).resolves.toBe(false);
  });
});

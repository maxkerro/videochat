import { makeEnvelope } from '@videochat/shared';
import { RealtimeClient, reconnectDelayMs } from './realtime.js';

describe('reconnectDelayMs', () => {
  it('grows exponentially with the attempt number', () => {
    const fixedRandom = () => 0; // isolates the exponential part from the jitter
    expect(reconnectDelayMs(0, fixedRandom)).toBe(250); // 500/2
    expect(reconnectDelayMs(1, fixedRandom)).toBe(500); // 1000/2
    expect(reconnectDelayMs(2, fixedRandom)).toBe(1000); // 2000/2
  });

  it('caps at 30s no matter how many attempts', () => {
    expect(reconnectDelayMs(20, () => 1)).toBe(30_000);
  });

  it('jitters within the lower half of the window, never past the cap', () => {
    const delays = Array.from({ length: 50 }, () => reconnectDelayMs(3, Math.random));
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(2000); // 4000/2
      expect(d).toBeLessThanOrEqual(4000);
    }
  });
});

/** A minimal fake of the browser WebSocket, enough to drive RealtimeClient without a network. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners: Record<string, ((event?: unknown) => void)[]> = {};
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event?: unknown) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  close() {
    this.closed = true;
    this.emit('close');
  }

  emit(type: string, event?: unknown) {
    for (const handler of this.listeners[type] ?? []) handler(event);
  }
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('opens a socket with the access token in the URL', () => {
    const client = new RealtimeClient({
      url: 'ws://api.test/realtime',
      getAccessToken: () => 'tok-123',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://api.test/realtime?token=tok-123');
  });

  it('reports status changes and delivers parsed envelopes', () => {
    const statuses: string[] = [];
    const events: unknown[] = [];
    const client = new RealtimeClient({
      url: 'ws://api.test/realtime',
      getAccessToken: () => 'tok',
      onStatusChange: (s) => statuses.push(s),
      onEvent: (e) => events.push(e),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    const envelope = makeEnvelope('message.new', { text: 'hi' }, 'evt-1');
    socket.emit('message', { data: JSON.stringify(envelope) });

    expect(statuses).toEqual(['connecting', 'open']);
    expect(events).toEqual([envelope]);
  });

  it('ignores a message that is not a valid envelope', () => {
    const events: unknown[] = [];
    const client = new RealtimeClient({
      url: 'ws://api.test/realtime',
      getAccessToken: () => 'tok',
      onEvent: (e) => events.push(e),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    FakeWebSocket.instances[0]!.emit('message', { data: JSON.stringify({ not: 'an envelope' }) });
    expect(events).toEqual([]);
  });

  it('reconnects with backoff after an unrequested close', () => {
    const client = new RealtimeClient({
      url: 'ws://api.test/realtime',
      getAccessToken: () => 'tok',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      random: () => 0,
    });
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]!.emit('close');
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet -- waiting on the backoff timer

    vi.advanceTimersByTime(reconnectDelayMs(0, () => 0));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('does not reconnect after an explicit disconnect()', () => {
    const client = new RealtimeClient({
      url: 'ws://api.test/realtime',
      getAccessToken: () => 'tok',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    client.disconnect();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('retries without opening a socket when there is no access token yet', () => {
    let hasToken = false;
    const client = new RealtimeClient({
      url: 'ws://api.test/realtime',
      getAccessToken: () => (hasToken ? 'tok' : null),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      random: () => 0,
    });
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(0);

    hasToken = true;
    vi.advanceTimersByTime(reconnectDelayMs(0, () => 0));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

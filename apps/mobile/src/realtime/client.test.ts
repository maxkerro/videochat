import { makeEnvelope } from '@videochat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, reconnectDelayMs, type RealtimeStatus, type SocketLike } from './client';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(type: string, payload: unknown = {}) {
    this.onmessage?.({ data: JSON.stringify(makeEnvelope(type, payload, 'e1')) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup(token: string | null = 'tok') {
  const sockets: FakeSocket[] = [];
  const statuses: RealtimeStatus[] = [];
  const events: string[] = [];
  const client = new RealtimeClient({
    url: 'wss://api.example/realtime',
    getAccessToken: () => Promise.resolve(token),
    onEvent: (e) => events.push(e.type),
    onStatus: (s) => statuses.push(s),
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0,
  });
  return { client, sockets, statuses, events };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('reconnectDelayMs', () => {
  it('grows with the attempt and is capped', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(250);
    expect(reconnectDelayMs(3, () => 0)).toBe(2_000);
    expect(reconnectDelayMs(30, () => 1)).toBe(30_000);
  });
});

describe('RealtimeClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects with the token and is "open" only once the server says ready', async () => {
    const { client, sockets, statuses } = setup();
    client.connect();
    await flush();
    expect(sockets[0]!.url).toBe('wss://api.example/realtime?token=tok');
    sockets[0]!.open();
    expect(statuses).toEqual(['connecting']);
    sockets[0]!.receive('realtime.ready', { connectionId: 'c' });
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('never opens a second socket while one exists or is being set up', async () => {
    const { client, sockets } = setup();
    client.connect();
    client.connect();
    await flush();
    client.connect();
    expect(sockets).toHaveLength(1);
  });

  it('retries with backoff after a drop, and stops after close()', async () => {
    const { client, sockets } = setup();
    client.connect();
    await flush();
    sockets[0]!.open();
    sockets[0]!.receive('realtime.ready');
    sockets[0]!.drop();
    expect(client.getStatus()).toBe('closed');
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets).toHaveLength(2);
    client.close();
    sockets[1]!.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('keeps backing off when the server accepts and immediately rejects the token', async () => {
    const { client, sockets } = setup();
    client.connect();
    await flush();
    for (let i = 0; i < 3; i++) {
      sockets.at(-1)!.open(); // handshake ok, but no realtime.ready before the close
      sockets.at(-1)!.drop();
      await vi.advanceTimersByTimeAsync(40_000);
    }
    // Delays 250, 500, 1000 ms (random = 0): still only a handful of sockets after 40 s each.
    expect(sockets.length).toBeLessThanOrEqual(5);
    expect(sockets.length).toBeGreaterThanOrEqual(4);
  });

  it('retries later when there is no token yet (signed out)', async () => {
    const { client, sockets } = setup(null);
    client.connect();
    await flush();
    expect(sockets).toHaveLength(0);
    client.close();
  });

  it('ignores events from a socket that was already closed', async () => {
    const { client, sockets, events } = setup();
    client.connect();
    await flush();
    const first = sockets[0]!;
    client.close();
    first.receive('message.new');
    expect(events).toEqual([]);
  });

  it('send() only goes out while the socket is open', async () => {
    const { client, sockets } = setup();
    expect(client.send(makeEnvelope('x', {}, 'i'))).toBe(false);
    client.connect();
    await flush();
    expect(client.send(makeEnvelope('x', {}, 'i'))).toBe(false);
    sockets[0]!.open();
    expect(client.send(makeEnvelope('x', {}, 'i'))).toBe(true);
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it('drops malformed frames without disturbing the connection', async () => {
    const { client, sockets, events } = setup();
    client.connect();
    await flush();
    sockets[0]!.onmessage?.({ data: 'not json' });
    sockets[0]!.onmessage?.({ data: JSON.stringify({ nope: true }) });
    sockets[0]!.receive('message.new');
    expect(events).toEqual(['message.new']);
  });
});

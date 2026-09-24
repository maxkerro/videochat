import type { JwtService } from '@nestjs/jwt';
import type { Database } from '../db/client.js';
import * as conversationsDb from '../db/conversations.js';
import { HEARTBEAT_INTERVAL_MS, RealtimeGateway } from './realtime.gateway.js';
import type { RealtimeService, RealtimeSocket } from './realtime.service.js';

vi.mock('../db/conversations.js', () => ({
  listConversationIdsForUser: vi.fn(),
}));

function makeClient(): RealtimeSocket {
  return {
    OPEN: 1,
    readyState: 1,
    close: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(),
  } as unknown as RealtimeSocket;
}

describe('RealtimeGateway', () => {
  let jwt: { verify: ReturnType<typeof vi.fn> };
  let realtime: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };
  let gateway: RealtimeGateway;

  beforeEach(() => {
    vi.mocked(conversationsDb.listConversationIdsForUser).mockResolvedValue(['conv-1']);
    jwt = { verify: vi.fn() };
    realtime = { register: vi.fn(), unregister: vi.fn() };
    gateway = new RealtimeGateway(
      jwt as unknown as JwtService,
      realtime as unknown as RealtimeService,
      {} as Database,
    );
  });

  describe('handleConnection', () => {
    it('registers the socket for a valid token', async () => {
      jwt.verify.mockReturnValue({ sub: 'user-1' });
      const client = makeClient();

      await gateway.handleConnection(client, { url: '/realtime?token=good' } as never);

      expect(client.close).not.toHaveBeenCalled();
      expect(realtime.register).toHaveBeenCalledWith(client, 'user-1', ['conv-1']);
      expect(client.isAlive).toBe(true);
      expect(client.on).toHaveBeenCalledWith('pong', expect.any(Function));
    });

    it('closes the connection when no token is provided', async () => {
      const client = makeClient();

      await gateway.handleConnection(client, { url: '/realtime' } as never);

      expect(client.close).toHaveBeenCalledWith(4401, expect.any(String));
      expect(realtime.register).not.toHaveBeenCalled();
    });

    it('closes the connection when the token fails verification', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('invalid signature');
      });
      const client = makeClient();

      await gateway.handleConnection(client, { url: '/realtime?token=bad' } as never);

      expect(client.close).toHaveBeenCalledWith(4401, expect.any(String));
      expect(realtime.register).not.toHaveBeenCalled();
    });

    it('marks the socket alive again on pong', async () => {
      jwt.verify.mockReturnValue({ sub: 'user-1' });
      const client = makeClient();

      await gateway.handleConnection(client, { url: '/realtime?token=good' } as never);
      client.isAlive = false;
      const pongHandler = vi
        .mocked(client.on)
        .mock.calls.find(([event]) => event === 'pong')?.[1] as (() => void) | undefined;
      pongHandler?.();

      expect(client.isAlive).toBe(true);
    });
  });

  describe('handleDisconnect', () => {
    it('unregisters the socket', () => {
      const client = makeClient();
      gateway.handleDisconnect(client);
      expect(realtime.unregister).toHaveBeenCalledWith(client);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('pings alive clients and terminates ones that missed the last pong', () => {
      const alive = makeClient();
      alive.isAlive = true;
      const dead = makeClient();
      dead.isAlive = false;
      const server = { clients: new Set([alive, dead]) };

      gateway.afterInit(server as never);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(alive.ping).toHaveBeenCalled();
      expect(alive.isAlive).toBe(false); // armed for the next tick
      expect(dead.terminate).toHaveBeenCalled();
    });

    it('stops ticking once the module is destroyed', () => {
      const alive = makeClient();
      alive.isAlive = true;
      const server = { clients: new Set([alive]) };

      gateway.afterInit(server as never);
      gateway.onModuleDestroy();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);

      expect(alive.ping).not.toHaveBeenCalled();
    });
  });
});

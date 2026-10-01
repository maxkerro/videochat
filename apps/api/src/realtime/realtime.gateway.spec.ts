import type { JwtService } from '@nestjs/jwt';
import { makeEnvelope } from '@videochat/shared';
import type { Database } from '../db/client.js';
import * as blocksDb from '../db/blocks.js';
import * as conversationsDb from '../db/conversations.js';
import * as usersDb from '../db/users.js';
import {
  HEARTBEAT_INTERVAL_MS,
  RealtimeGateway,
  TYPING_MIN_INTERVAL_MS,
} from './realtime.gateway.js';
import type { RealtimeService, RealtimeSocket } from './realtime.service.js';

vi.mock('../db/conversations.js', () => ({
  listConversationIdsForUser: vi.fn(),
  isConversationMember: vi.fn(),
}));

vi.mock('../db/blocks.js', () => ({
  isSenderBlockedInDirectConversation: vi.fn(),
}));

vi.mock('../db/users.js', () => ({
  findUserById: vi.fn(),
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
  let realtime: {
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
    publishToConversation: ReturnType<typeof vi.fn>;
  };
  let gateway: RealtimeGateway;

  beforeEach(() => {
    vi.mocked(conversationsDb.listConversationIdsForUser).mockResolvedValue(['conv-1']);
    vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(true);
    vi.mocked(blocksDb.isSenderBlockedInDirectConversation).mockResolvedValue(false);
    vi.mocked(usersDb.findUserById).mockResolvedValue({ displayName: 'Anna' } as never);
    jwt = { verify: vi.fn() };
    realtime = {
      register: vi.fn(),
      unregister: vi.fn(),
      publishToConversation: vi.fn().mockResolvedValue(undefined),
    };
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

  describe('handleClientMessage (CHAT-020 typing)', () => {
    const conversationId = '00000000-0000-4000-8000-000000000001';

    async function connectedClient(): Promise<RealtimeSocket> {
      jwt.verify.mockReturnValue({ sub: 'user-1' });
      const client = makeClient();
      await gateway.handleConnection(client, { url: '/realtime?token=good' } as never);
      // The real RealtimeService.register sets this; the mock above doesn't, so it's set here to
      // simulate a fully-registered connection the way handleClientMessage expects to find one.
      client.userId = 'user-1';
      return client;
    }

    // The gateway's own `on('message', ...)` listener fires-and-forgets the async handler (`void
    // this.handleClientMessage(...)`), so a test driving it through that listener can't await
    // completion. Calling the private method directly (still exercising the real registered
    // handler's logic -- this *is* what the listener calls) keeps every assertion below
    // deterministic instead of racing a background promise.
    function messageHandler(client: RealtimeSocket): (data: Buffer) => Promise<void> {
      expect(vi.mocked(client.on).mock.calls.some(([event]) => event === 'message')).toBe(true);
      return (data: Buffer) =>
        (
          gateway as unknown as {
            handleClientMessage: (c: RealtimeSocket, d: Buffer) => Promise<void>;
          }
        ).handleClientMessage(client, data);
    }

    it('re-broadcasts a valid typing signal with the server-known identity, never the client-supplied one', async () => {
      const client = await connectedClient();
      const envelope = makeEnvelope(
        'conversation.typing',
        { conversationId, userId: 'someone-else', displayName: 'Not Anna' },
        'evt-1',
      );

      await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));

      expect(conversationsDb.isConversationMember).toHaveBeenCalledWith(
        expect.anything(),
        conversationId,
        'user-1',
      );
      expect(realtime.publishToConversation).toHaveBeenCalledWith(
        conversationId,
        expect.objectContaining({
          type: 'conversation.typing',
          payload: { conversationId, userId: 'user-1', displayName: 'Anna' },
        }),
      );
    });

    it('does nothing for a conversation the connection is not a member of', async () => {
      vi.mocked(conversationsDb.isConversationMember).mockResolvedValue(false);
      const client = await connectedClient();
      const envelope = makeEnvelope('conversation.typing', { conversationId }, 'evt-1');

      await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));

      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    // Review follow-up to CHAT-021: the same block enforcement `MessagesService.send()` applies
    // to a DM should stop a blocked sender's typing signal too, not just their messages.
    it('does not re-broadcast a typing signal into a DM where the recipient has blocked the sender', async () => {
      vi.mocked(blocksDb.isSenderBlockedInDirectConversation).mockResolvedValue(true);
      const client = await connectedClient();
      const envelope = makeEnvelope('conversation.typing', { conversationId }, 'evt-1');

      await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));

      expect(blocksDb.isSenderBlockedInDirectConversation).toHaveBeenCalledWith(
        expect.anything(),
        conversationId,
        'user-1',
      );
      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('ignores an envelope of an unknown type', async () => {
      const client = await connectedClient();
      const envelope = makeEnvelope('some.other.type', { conversationId }, 'evt-1');

      await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));

      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('ignores malformed JSON and a payload missing conversationId, without throwing', async () => {
      const client = await connectedClient();

      await expect(messageHandler(client)(Buffer.from('not json'))).resolves.toBeUndefined();
      await messageHandler(client)(
        Buffer.from(JSON.stringify(makeEnvelope('conversation.typing', {}, 'evt-1'))),
      );

      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('ignores a message received before registration finishes (no userId yet)', async () => {
      jwt.verify.mockReturnValue({ sub: 'user-1' });
      const client = makeClient();
      await gateway.handleConnection(client, { url: '/realtime?token=good' } as never);
      // Deliberately not setting client.userId, simulating a message that races ahead of
      // RealtimeService.register (see the comment on this in handleConnection/handleClientMessage).

      const envelope = makeEnvelope('conversation.typing', { conversationId }, 'evt-1');
      await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));

      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('throttles a second typing signal from the same connection inside the minimum interval', async () => {
      vi.useFakeTimers();
      try {
        const client = await connectedClient();
        const envelope = makeEnvelope('conversation.typing', { conversationId }, 'evt-1');

        await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));
        await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));
        expect(realtime.publishToConversation).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(TYPING_MIN_INTERVAL_MS);
        await messageHandler(client)(Buffer.from(JSON.stringify(envelope)));
        expect(realtime.publishToConversation).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
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

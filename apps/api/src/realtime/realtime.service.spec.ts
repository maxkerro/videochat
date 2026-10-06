import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { isSessionEnded, RealtimeService, type RealtimeSocket } from './realtime.service.js';

/** A `duplicate()`d subscriber connection is a separate object from the main client in ioredis;
 *  this fakes just enough of it (connect/quit/psubscribe plus the real EventEmitter `pmessage`
 *  event) to drive RealtimeService without a real Redis. */
function makeFakeRedis() {
  const subscriber = Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    psubscribe: vi.fn().mockResolvedValue(undefined),
  });
  const redis = {
    duplicate: vi.fn().mockReturnValue(subscriber),
    publish: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
  return { redis, subscriber };
}

function makeSocket(readyState = 1): RealtimeSocket {
  return {
    OPEN: 1,
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as RealtimeSocket;
}

describe('RealtimeService', () => {
  it('subscribes to the conversation, user and (CHAT-041) connection wildcard channels on module init', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleInit();
    expect(subscriber.connect).toHaveBeenCalled();
    expect(subscriber.psubscribe).toHaveBeenCalledWith('conv:*', 'user:*', 'conn:*');
  });

  it('publishes a conversation event to the conv:{id} channel', async () => {
    const { redis } = makeFakeRedis();
    const service = new RealtimeService(redis);
    const envelope = {
      v: 1 as const,
      type: 'message.new',
      id: 'e1',
      ts: '2026-01-01T00:00:00Z',
      payload: {},
    };

    await service.publishToConversation('conv-1', envelope);

    expect(redis.publish).toHaveBeenCalledWith('conv:conv-1', JSON.stringify(envelope));
  });

  it('publishes a user event to the user:{id} channel', async () => {
    const { redis } = makeFakeRedis();
    const service = new RealtimeService(redis);
    const envelope = {
      v: 1 as const,
      type: 'pong',
      id: 'e2',
      ts: '2026-01-01T00:00:00Z',
      payload: {},
    };

    await service.publishToUser('user-1', envelope);

    expect(redis.publish).toHaveBeenCalledWith('user:user-1', JSON.stringify(envelope));
  });

  it('delivers a conv: pmessage only to sockets registered on that conversation', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleInit();

    const member = makeSocket();
    const stranger = makeSocket();
    service.register(member, 'user-a', ['conv-1']);
    service.register(stranger, 'user-b', ['conv-2']);

    subscriber.emit('pmessage', 'conv:*', 'conv:conv-1', '{"type":"message.new"}');

    expect(member.send).toHaveBeenCalledWith('{"type":"message.new"}');
    expect(stranger.send).not.toHaveBeenCalled();
  });

  it('delivers a user: pmessage to every socket of that user', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleInit();

    const tabA = makeSocket();
    const tabB = makeSocket();
    service.register(tabA, 'user-a', []);
    service.register(tabB, 'user-a', []);

    subscriber.emit('pmessage', 'user:*', 'user:user-a', '{"type":"session.revoked"}');

    expect(tabA.send).toHaveBeenCalledWith('{"type":"session.revoked"}');
    expect(tabB.send).toHaveBeenCalledWith('{"type":"session.revoked"}');
  });

  it('CHAT-037: closes sockets and tells listeners only for a real session.ended envelope', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleInit();
    const ended = vi.fn();
    service.onSessionEnded(ended);
    const tab = makeSocket();
    service.register(tab, 'user-a', []);

    // User-chosen text that happens to be the marker must not sign anyone out.
    subscriber.emit(
      'pmessage',
      'user:*',
      'user:user-a',
      JSON.stringify({ type: 'me.updated', payload: { displayName: 'session.ended' } }),
    );
    expect(tab.close).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();

    // The real thing -- and listeners hear it even for a user with no socket on this node.
    subscriber.emit('pmessage', 'user:*', 'user:user-b', '{"type":"session.ended"}');
    expect(ended).toHaveBeenCalledWith('user-b');
    subscriber.emit('pmessage', 'user:*', 'user:user-a', '{"type":"session.ended"}');
    expect(tab.close).toHaveBeenCalledWith(4401, 'Session ended');
  });

  it('isSessionEnded parses rather than substring-matches', () => {
    expect(isSessionEnded('{"type":"session.ended","payload":{}}')).toBe(true);
    expect(
      isSessionEnded('{"type":"conversation.added","payload":{"title":"session.ended"}}'),
    ).toBe(false);
    expect(isSessionEnded('not json "session.ended"')).toBe(false);
  });

  it('never sends to a socket that is not open', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleInit();

    const closing = makeSocket(2); // CLOSING
    service.register(closing, 'user-a', ['conv-1']);

    subscriber.emit('pmessage', 'conv:*', 'conv:conv-1', 'hi');

    expect(closing.send).not.toHaveBeenCalled();
  });

  it('stops delivering to a socket once unregistered', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleInit();

    const client = makeSocket();
    service.register(client, 'user-a', ['conv-1']);
    service.unregister(client);

    subscriber.emit('pmessage', 'conv:*', 'conv:conv-1', 'hi');
    subscriber.emit('pmessage', 'user:*', 'user:user-a', 'hi');

    expect(client.send).not.toHaveBeenCalled();
  });

  it('quits the subscriber connection on module destroy', async () => {
    const { redis, subscriber } = makeFakeRedis();
    const service = new RealtimeService(redis);
    await service.onModuleDestroy();
    expect(subscriber.quit).toHaveBeenCalled();
  });

  describe('addConversationForUser', () => {
    it('lets an already-open socket start hearing about a conversation it connected before', async () => {
      const { redis, subscriber } = makeFakeRedis();
      const service = new RealtimeService(redis);
      await service.onModuleInit();

      // Connected before this conversation existed, so `register` never saw it.
      const socket = makeSocket();
      service.register(socket, 'user-a', []);

      service.addConversationForUser('user-a', 'conv-new');
      subscriber.emit('pmessage', 'conv:*', 'conv:conv-new', 'hi');

      expect(socket.send).toHaveBeenCalledWith('hi');
    });

    it('does nothing for a user with no open sockets', () => {
      const { redis } = makeFakeRedis();
      const service = new RealtimeService(redis);
      // Would throw if it assumed a socket set always exists for a known/unknown user.
      expect(() => service.addConversationForUser('nobody-connected', 'conv-1')).not.toThrow();
    });

    it('stops delivering once that socket disconnects, same as any other conversation', async () => {
      const { redis, subscriber } = makeFakeRedis();
      const service = new RealtimeService(redis);
      await service.onModuleInit();

      const socket = makeSocket();
      service.register(socket, 'user-a', []);
      service.addConversationForUser('user-a', 'conv-new');
      service.unregister(socket);

      subscriber.emit('pmessage', 'conv:*', 'conv:conv-new', 'hi');

      expect(socket.send).not.toHaveBeenCalled();
    });
  });

  describe('removeConversationForUser (CHAT-018)', () => {
    it('stops an already-open socket from hearing about a conversation immediately', async () => {
      const { redis, subscriber } = makeFakeRedis();
      const service = new RealtimeService(redis);
      await service.onModuleInit();

      const socket = makeSocket();
      service.register(socket, 'removed-user', ['conv-1']);

      service.removeConversationForUser('removed-user', 'conv-1');
      subscriber.emit('pmessage', 'conv:*', 'conv:conv-1', 'hi');

      expect(socket.send).not.toHaveBeenCalled();
    });

    it('leaves the socket registered for its other conversations', async () => {
      const { redis, subscriber } = makeFakeRedis();
      const service = new RealtimeService(redis);
      await service.onModuleInit();

      const socket = makeSocket();
      service.register(socket, 'removed-user', ['conv-1', 'conv-2']);

      service.removeConversationForUser('removed-user', 'conv-1');
      subscriber.emit('pmessage', 'conv:*', 'conv:conv-2', 'still here');

      expect(socket.send).toHaveBeenCalledWith('still here');
    });

    it('does nothing for a user with no open sockets', () => {
      const { redis } = makeFakeRedis();
      const service = new RealtimeService(redis);
      expect(() => service.removeConversationForUser('nobody-connected', 'conv-1')).not.toThrow();
    });
  });
});

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { WsEnvelope } from '@videochat/shared';
import { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import { REDIS } from '../infra/tokens.js';

/** A connected socket, tagged with what it's allowed to receive once authenticated. */
export interface RealtimeSocket extends WebSocket {
  isAlive?: boolean;
  userId?: string;
  /** Snapshot, taken at connect time, of the conversations this socket should hear about.
   *  CHAT-013 doesn't push live updates into this set when membership changes mid-connection
   *  (joining a new group won't stream to an already-open socket) -- acceptable for now, and a
   *  natural fit for CHAT-018 (group membership changes) to close and let the client reconnect. */
  conversationIds?: Set<string>;
}

function conversationChannel(conversationId: string): string {
  return `conv:${conversationId}`;
}

function userChannel(userId: string): string {
  return `user:${userId}`;
}

/**
 * Local (per-node) socket registry plus the Redis pub/sub bridge that lets a message published
 * on any API node reach a client connected to any other node (CHAT-013's fan-out requirement).
 *
 * Simplification: rather than subscribing/unsubscribing individual `conv:{id}`/`user:{id}`
 * channels as clients connect and disconnect, every node subscribes to both wildcard patterns
 * once and filters locally against its own registry. At this project's scale that's a lot
 * simpler than keeping per-channel subscription refcounts in sync across nodes, at the cost of
 * every node seeing every publish (cheap: a Redis pub/sub message, not a DB read).
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly subscriber: Redis;
  private readonly byUser = new Map<string, Set<RealtimeSocket>>();
  private readonly byConversation = new Map<string, Set<RealtimeSocket>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.subscriber = redis.duplicate();
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.deliverLocally(channel, message);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.subscriber.connect().catch((err: Error) => {
      this.logger.warn(`Realtime subscriber not connected at startup: ${err.message}`);
    });
    await this.subscriber.psubscribe('conv:*', 'user:*').catch((err: Error) => {
      this.logger.warn(`Realtime psubscribe failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.quit().catch(() => undefined);
  }

  /** Registers a freshly authenticated socket so pub/sub deliveries know where to fan out. */
  register(client: RealtimeSocket, userId: string, conversationIds: readonly string[]): void {
    client.userId = userId;
    client.conversationIds = new Set(conversationIds);

    addToSetMap(this.byUser, userId, client);
    for (const conversationId of client.conversationIds) {
      addToSetMap(this.byConversation, conversationId, client);
    }
  }

  unregister(client: RealtimeSocket): void {
    if (client.userId) removeFromSetMap(this.byUser, client.userId, client);
    for (const conversationId of client.conversationIds ?? []) {
      removeFromSetMap(this.byConversation, conversationId, client);
    }
  }

  /**
   * Extends a user's already-open sockets to also hear about one more conversation, without
   * making them reconnect. `register` only snapshots a socket's conversations at connect time
   * (see the class comment on `RealtimeSocket`), so without this, starting a brand-new direct
   * conversation (CHAT-012) with someone who was already connected -- sitting on their inbox,
   * say -- would leave their open socket unaware of it: the first message sent into it would
   * publish to `conv:{id}`, but their socket was never added to `byConversation` for that id,
   * so `deliverLocally` would silently skip them until they happened to reconnect.
   */
  addConversationForUser(userId: string, conversationId: string): void {
    const sockets = this.byUser.get(userId);
    if (!sockets) return;
    for (const socket of sockets) {
      socket.conversationIds?.add(conversationId);
      addToSetMap(this.byConversation, conversationId, socket);
    }
  }

  /** Broadcasts to every member of a conversation, on every node. */
  async publishToConversation(conversationId: string, envelope: WsEnvelope): Promise<void> {
    await this.redis.publish(conversationChannel(conversationId), JSON.stringify(envelope));
  }

  /** Sends to every open socket of one user (their other devices/tabs), on every node. */
  async publishToUser(userId: string, envelope: WsEnvelope): Promise<void> {
    await this.redis.publish(userChannel(userId), JSON.stringify(envelope));
  }

  private deliverLocally(channel: string, message: string): void {
    const targets = channel.startsWith('conv:')
      ? this.byConversation.get(channel.slice('conv:'.length))
      : channel.startsWith('user:')
        ? this.byUser.get(channel.slice('user:'.length))
        : undefined;
    if (!targets) return;
    for (const client of targets) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }
}

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeFromSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

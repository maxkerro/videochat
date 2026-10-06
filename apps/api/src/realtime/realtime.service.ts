import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { makeEnvelope, type WsEnvelope } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import { REDIS } from '../infra/tokens.js';

/** A connected socket, tagged with what it's allowed to receive once authenticated. */
export interface RealtimeSocket extends WebSocket {
  isAlive?: boolean;
  userId?: string;
  /** CHAT-041: unique per socket (one per tab/device connection). Calls are tied to the one
   *  connection that placed or answered them, so negotiation reaches that device only. */
  connectionId?: string;
  /** CHAT-020: this connection's own display name, cached at connect time so the gateway can
   *  embed it in a typing event without a DB round trip per keystroke (see `RealtimeGateway`'s
   *  `handleConnection`). */
  displayName?: string;
  /** CHAT-020: `Date.now()` of the last typing signal accepted from this connection -- the
   *  server-side defense-in-depth throttle (see `TYPING_MIN_INTERVAL_MS`). */
  lastTypingAt?: number;
  /** CHAT-034: settles once this socket's presence entry is written. A disconnect waits for it, so
   *  the removal can't land before the add and leave a ghost "online" connection. */
  presenceReady?: Promise<void>;
  /** Snapshot, taken at connect time, of the conversations this socket should hear about.
   *  CHAT-013 doesn't push live updates into this set when membership changes mid-connection, but
   *  `RealtimeService.addConversationForUser`/`removeConversationForUser` (CHAT-012/CHAT-018) patch
   *  it directly for the two cases that need to take effect immediately: gaining a brand-new
   *  conversation, and losing one via group leave/removal. Anything else about a group changing
   *  (a rename, a role change) doesn't need this at all -- it's carried in the ordinary
   *  `message.new` system message and the next HTTP fetch, not a socket-membership update. */
  conversationIds?: Set<string>;
}

/** Same code as an unauthorised connect: the client treats both as "sign in again". */
export const SESSION_ENDED_CLOSE_CODE = 4401;

export type SessionEndReason = 'account-deleted' | 'password-changed';

/** Publishes the `session.ended` control message that makes every node close a user's sockets.
 *  A plain function so auth code can use it without depending on the realtime module. */
export async function publishSessionEnded(
  redis: Redis,
  userId: string,
  reason: SessionEndReason,
): Promise<void> {
  await redis.publish(
    userChannel(userId),
    JSON.stringify(makeEnvelope('session.ended', { reason }, randomUUID())),
  );
}

function conversationChannel(conversationId: string): string {
  return `conv:${conversationId}`;
}

function userChannel(userId: string): string {
  return `user:${userId}`;
}

function connectionChannel(connectionId: string): string {
  return `conn:${connectionId}`;
}

/** CHAT-041: handles client->server envelopes of one `type` prefix (e.g. `call.`), registered by
 *  feature modules so the gateway doesn't have to depend on them. */
export type InboundHandler = (client: RealtimeSocket, envelope: WsEnvelope) => Promise<void>;
/** CHAT-041: told whenever an authenticated socket closes. */
export type DisconnectListener = (client: RealtimeSocket) => Promise<void>;

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
  private readonly sessionEndedListeners: Array<(userId: string) => void> = [];
  private readonly byUser = new Map<string, Set<RealtimeSocket>>();
  private readonly byConversation = new Map<string, Set<RealtimeSocket>>();
  private readonly byConnection = new Map<string, RealtimeSocket>();
  private readonly inboundHandlers = new Map<string, InboundHandler>();
  private readonly disconnectListeners: DisconnectListener[] = [];

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
    await this.subscriber.psubscribe('conv:*', 'user:*', 'conn:*').catch((err: Error) => {
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
    if (client.connectionId) this.byConnection.set(client.connectionId, client);
    for (const conversationId of client.conversationIds) {
      addToSetMap(this.byConversation, conversationId, client);
    }
  }

  unregister(client: RealtimeSocket): void {
    if (client.userId) removeFromSetMap(this.byUser, client.userId, client);
    if (client.connectionId && this.byConnection.get(client.connectionId) === client) {
      this.byConnection.delete(client.connectionId);
    }
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

  /**
   * CHAT-018: the mirror of {@link addConversationForUser} -- stops a user's already-open sockets
   * from hearing about one conversation right away, e.g. immediately after they're removed from a
   * group (or leave it). Removing the socket from the local `byConversation` registry, rather than
   * force-closing it so the client reconnects with a fresh snapshot, is enough on its own to
   * satisfy "removed members stop receiving messages immediately": the very next
   * `publishToConversation` for this id simply won't find this socket in the registry any more.
   * It's also simpler and less disruptive than a forced close -- the socket stays open and still
   * correctly registered for every *other* conversation it belongs to, so a group removal doesn't
   * cost the person their connection to everything else they have open.
   */
  removeConversationForUser(userId: string, conversationId: string): void {
    const sockets = this.byUser.get(userId);
    if (!sockets) return;
    for (const socket of sockets) {
      socket.conversationIds?.delete(conversationId);
      removeFromSetMap(this.byConversation, conversationId, socket);
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

  /** CHAT-041: sends to exactly one socket (one device's connection), on whichever node holds it. */
  async publishToConnection(connectionId: string, envelope: WsEnvelope): Promise<void> {
    await this.redis.publish(connectionChannel(connectionId), JSON.stringify(envelope));
  }

  /** CHAT-041: routes client->server envelopes whose `type` starts with `prefix` to `handler`. */
  registerInboundHandler(prefix: string, handler: InboundHandler): void {
    this.inboundHandlers.set(prefix, handler);
  }

  /** Returns true if a registered handler took the envelope. */
  async dispatchInbound(client: RealtimeSocket, envelope: WsEnvelope): Promise<boolean> {
    for (const [prefix, handler] of this.inboundHandlers) {
      if (envelope.type.startsWith(prefix)) {
        await handler(client, envelope);
        return true;
      }
    }
    return false;
  }

  onDisconnect(listener: DisconnectListener): void {
    this.disconnectListeners.push(listener);
  }

  /** Called by the gateway once an authenticated socket has closed and been unregistered. */
  async notifyDisconnected(client: RealtimeSocket): Promise<void> {
    for (const listener of this.disconnectListeners) {
      await listener(client).catch((err: Error) => {
        this.logger.warn(`Disconnect listener failed: ${err.message}`);
      });
    }
  }

  /**
   * CHAT-037 review: closes every open socket of a user, on every node (account deleted, or
   * password changed -- "your other devices were signed out" includes their live connections).
   * Each socket is told why first (`session.ended`) and closed with code 4401.
   */
  async closeUserConnections(userId: string, reason: SessionEndReason): Promise<void> {
    await publishSessionEnded(this.redis, userId, reason);
  }

  /** CHAT-037 review: told on *every* node (each one pattern-subscribes to `user:*`) when a user's
   *  sessions end, whether or not that user has sockets here -- e.g. so each node's token-state
   *  cache forgets them at once. */
  onSessionEnded(listener: (userId: string) => void): void {
    this.sessionEndedListeners.push(listener);
  }

  private deliverLocally(channel: string, message: string): void {
    if (channel.startsWith('conn:')) {
      const client = this.byConnection.get(channel.slice('conn:'.length));
      if (client && client.readyState === client.OPEN) client.send(message);
      return;
    }
    const endsSession = channel.startsWith('user:') && isSessionEnded(message);
    if (endsSession) {
      const userId = channel.slice('user:'.length);
      for (const listener of this.sessionEndedListeners) listener(userId);
    }
    const targets = channel.startsWith('conv:')
      ? this.byConversation.get(channel.slice('conv:'.length))
      : channel.startsWith('user:')
        ? this.byUser.get(channel.slice('user:'.length))
        : undefined;
    if (!targets) return;
    for (const client of [...targets]) {
      if (client.readyState === client.OPEN) client.send(message);
      if (endsSession) client.close(SESSION_ENDED_CLOSE_CODE, 'Session ended');
    }
  }
}

/**
 * Whether a user-channel message is the `session.ended` control envelope. By its parsed `type`,
 * never by a substring: other envelopes on the channel carry user-chosen text (a display name or
 * group title that is literally "session.ended" must not sign anyone out). The cheap substring test
 * only skips parsing for the vast majority that can't match.
 */
export function isSessionEnded(message: string): boolean {
  if (!message.includes('session.ended')) return false;
  try {
    return (JSON.parse(message) as { type?: unknown }).type === 'session.ended';
  } catch {
    return false;
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

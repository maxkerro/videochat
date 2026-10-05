import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import { randomUUID } from 'node:crypto';
import type { Server } from 'ws';
import {
  makeEnvelope,
  typingSignalSchema,
  wsEnvelopeSchema,
  type RealtimeReady,
  type TypingEvent,
  type WsEnvelope,
} from '@videochat/shared';
import type { AccessTokenPayload } from '../auth/access-token.guard.js';
import type { Database } from '../db/client.js';
import { isSenderBlockedInDirectConversation } from '../db/blocks.js';
import { isConversationMember, listConversationIdsForUser } from '../db/conversations.js';
import { findUserById } from '../db/users.js';
import { DB } from '../infra/tokens.js';
import { TokenStateService } from '../auth/token-state.service.js';
import { PresenceService } from './presence.service.js';
import { RealtimeService, type RealtimeSocket } from './realtime.service.js';

/**
 * CHAT-020 defense-in-depth: the AC's "throttled to one per 3s per user" is primarily the
 * client's job (see `TypingThrottle` on the web side), but a spammy or malicious client could
 * otherwise flood `publishToConversation` -- and every other member's socket -- with typing
 * events with no rate limit at all. This is deliberately a simple per-connection timestamp guard,
 * not a shared/distributed rate limiter: CHAT-021 "rate limiting" is a dedicated later story, and
 * anything fancier here would be solving that story early for one endpoint. Set below the
 * client's own 3s throttle so ordinary clock jitter between client and server never drops a
 * legitimate signal.
 */
export const TYPING_MIN_INTERVAL_MS = 2_000;

/** Ping every 25 s (CHAT-013 AC); a socket that hasn't answered by the next tick is dead. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** Close code for an unauthenticated connection -- in the app-defined 4000-4999 range, so it
 *  never collides with a protocol-level close code a client might special-case. */
const UNAUTHORIZED_CLOSE_CODE = 4401;

/**
 * Authenticated realtime endpoint (CHAT-013): `wss://.../realtime?token=<access token>`. The
 * token travels as a query parameter, not an `Authorization` header, because the browser
 * `WebSocket` constructor can't set custom headers.
 */
@WebSocketGateway({ path: '/realtime' })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private heartbeatTimer?: NodeJS.Timeout;

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeService,
    @Inject(DB) private readonly db: Database,
    private readonly presence: PresenceService,
    private readonly tokenState: TokenStateService,
  ) {}

  afterInit(server: Server): void {
    this.heartbeatTimer = setInterval(() => {
      const live: Array<{ userId: string; connectionId: string }> = [];
      for (const raw of server.clients) {
        const client = raw as RealtimeSocket;
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
        if (client.userId && client.connectionId) {
          live.push({ userId: client.userId, connectionId: client.connectionId });
        }
      }
      // CHAT-034: keeps every live connection's presence entry from lapsing.
      void this.presence.refresh(live);
    }, HEARTBEAT_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeatTimer);
  }

  async handleConnection(client: RealtimeSocket, request: IncomingMessage): Promise<void> {
    const auth = this.authenticate(request);
    // CHAT-037 review: a deleted account, or a token from before a password change, can't connect.
    const userId =
      auth && (await this.tokenState.isTokenValid(auth.sub, auth.iat)) ? auth.sub : undefined;
    if (!userId) {
      this.logger.debug('Rejected realtime connection: missing or invalid access token');
      client.close(UNAUTHORIZED_CLOSE_CODE, 'Missing or invalid access token');
      return;
    }

    client.isAlive = true;
    client.connectionId = randomUUID();
    client.on('pong', () => {
      client.isAlive = true;
    });
    client.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      void this.handleClientMessage(client, data);
    });

    const [conversationIds, user] = await Promise.all([
      listConversationIdsForUser(this.db, userId),
      findUserById(this.db, userId),
    ]);
    // Cached on the socket at connect time (like `conversationIds`) rather than looked up per
    // typing event -- CHAT-020's typing signal has no persisted row for the receiving client to
    // join against later, so the server has to embed a display name itself, and doing that with a
    // DB round trip on every keystroke-driven event would be wasteful for something this frequent.
    client.displayName = user?.displayName;
    // Closed while we were loading: `handleDisconnect` already ran (and found nothing registered),
    // so registering now would leave a dead socket -- and a ghost presence entry -- behind.
    if (client.readyState !== client.OPEN) return;
    this.realtime.register(client, userId, conversationIds);
    client.presenceReady = this.presence.connected(userId, client.connectionId);

    // The client's WebSocket fires `open` as soon as the handshake completes, which is before
    // this handler's DB query and registration above finish -- there's no way to delay `open`
    // itself. Until this confirmation arrives, a message published into one of the client's
    // conversations can race ahead of `register()` and be silently dropped (deliverLocally only
    // sees sockets already in its registry). A client -- or a test -- that waits for this event
    // instead of `open` before assuming it will hear about new activity closes that window.
    if (client.readyState === client.OPEN) {
      // CHAT-041: the socket's own id, so a device can tell its own call answer from another
      // device's ("answered elsewhere").
      const ready: RealtimeReady = { connectionId: client.connectionId };
      client.send(JSON.stringify(makeEnvelope('realtime.ready', ready, randomUUID())));
    }
  }

  handleDisconnect(client: RealtimeSocket): void {
    this.realtime.unregister(client);
    if (client.userId && client.connectionId) {
      const { userId, connectionId } = client;
      // After the connect's presence write, never before it (see `presenceReady`).
      void (client.presenceReady ?? Promise.resolve()).then(() =>
        this.presence.disconnected(userId, connectionId),
      );
    }
    // Only sockets that finished authenticating can be in a call.
    if (client.userId) void this.realtime.notifyDisconnected(client);
  }

  /** Verifies the access token from the connection URL's `token` query parameter, the same
   *  token issued to `AccessTokenGuard` for ordinary HTTP requests. */
  private authenticate(request: IncomingMessage): AccessTokenPayload | undefined {
    const token = new URL(request.url ?? '', 'ws://localhost').searchParams.get('token');
    if (!token) return undefined;
    try {
      return this.jwt.verify<AccessTokenPayload>(token);
    } catch {
      return undefined;
    }
  }

  /**
   * CHAT-020: the first purely client-initiated, HTTP-free realtime signal -- everything else so
   * far only flows server-to-client (the client's own inbound traffic to date is just the
   * protocol-level pong `handleConnection` already listens for). Anything that doesn't parse as a
   * `WsEnvelope`, or whose `type` isn't one this gateway knows how to handle inbound, is silently
   * ignored rather than closing the connection -- an untrusted client's malformed message is no
   * different from one it simply doesn't understand yet.
   */
  private async handleClientMessage(
    client: RealtimeSocket,
    data: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    if (!client.userId) return; // Registration (see handleConnection) hasn't finished yet.

    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return;
    }
    const envelope = wsEnvelopeSchema.safeParse(json);
    if (!envelope.success) return;

    if (envelope.data.type === 'conversation.typing') {
      await this.handleTyping(client, client.userId, envelope.data.payload);
      return;
    }
    // CHAT-041: feature modules (calls) register their own inbound types; anything unclaimed is
    // ignored like any other unknown message.
    await this.realtime.dispatchInbound(client, envelope.data as WsEnvelope).catch((err: Error) => {
      this.logger.warn(`Inbound ${envelope.data.type} failed: ${err.message}`);
    });
  }

  /** Re-broadcasts a member's "I'm typing" signal to the rest of the conversation, over realtime
   *  pub/sub -- it persists no row of its own (see `typingEventSchema`'s comment), but it does
   *  make one read against the block table below, the same review follow-up to CHAT-021 that
   *  added the equivalent check to `MessagesService.send()`: "a blocked user's messages to you are
   *  rejected" is a hollow guarantee if that same blocked person can still show up as "typing..."
   *  in the DM every time they touch their keyboard. The sender's `userId`/`displayName` are
   *  always taken from the authenticated connection, never from the client's payload, and
   *  membership is re-checked here rather than trusting the client's claimed `conversationId` (the
   *  same authorisation concern as every other conversation-scoped action in this codebase). */
  private async handleTyping(
    client: RealtimeSocket,
    userId: string,
    payload: unknown,
  ): Promise<void> {
    const parsed = typingSignalSchema.safeParse(payload);
    if (!parsed.success) return;

    const now = Date.now();
    if (client.lastTypingAt !== undefined && now - client.lastTypingAt < TYPING_MIN_INTERVAL_MS)
      return;
    client.lastTypingAt = now;

    const { conversationId } = parsed.data;
    if (!(await isConversationMember(this.db, conversationId, userId))) return;
    // Scoped to direct conversations only, same as `MessagesService.send()` -- see
    // `isSenderBlockedInDirectConversation`'s own comment for why block enforcement doesn't extend
    // to groups. Silently dropped rather than an error: unlike a message send, there's no client
    // waiting on an ack to show as failed, and a blocked sender has no way to distinguish "not
    // delivered" from "the other person just hasn't looked at their phone".
    if (await isSenderBlockedInDirectConversation(this.db, conversationId, userId)) return;

    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope<TypingEvent>(
        'conversation.typing',
        { conversationId, userId, displayName: client.displayName ?? '' },
        randomUUID(),
      ),
    );
  }
}

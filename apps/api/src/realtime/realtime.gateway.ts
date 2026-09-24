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
import { makeEnvelope } from '@videochat/shared';
import type { AccessTokenPayload } from '../auth/access-token.guard.js';
import type { Database } from '../db/client.js';
import { listConversationIdsForUser } from '../db/conversations.js';
import { DB } from '../infra/tokens.js';
import { RealtimeService, type RealtimeSocket } from './realtime.service.js';

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
  ) {}

  afterInit(server: Server): void {
    this.heartbeatTimer = setInterval(() => {
      for (const raw of server.clients) {
        const client = raw as RealtimeSocket;
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeatTimer);
  }

  async handleConnection(client: RealtimeSocket, request: IncomingMessage): Promise<void> {
    const userId = this.authenticate(request);
    if (!userId) {
      this.logger.debug('Rejected realtime connection: missing or invalid access token');
      client.close(UNAUTHORIZED_CLOSE_CODE, 'Missing or invalid access token');
      return;
    }

    client.isAlive = true;
    client.on('pong', () => {
      client.isAlive = true;
    });

    const conversationIds = await listConversationIdsForUser(this.db, userId);
    this.realtime.register(client, userId, conversationIds);

    // The client's WebSocket fires `open` as soon as the handshake completes, which is before
    // this handler's DB query and registration above finish -- there's no way to delay `open`
    // itself. Until this confirmation arrives, a message published into one of the client's
    // conversations can race ahead of `register()` and be silently dropped (deliverLocally only
    // sees sockets already in its registry). A client -- or a test -- that waits for this event
    // instead of `open` before assuming it will hear about new activity closes that window.
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(makeEnvelope('realtime.ready', {}, randomUUID())));
    }
  }

  handleDisconnect(client: RealtimeSocket): void {
    this.realtime.unregister(client);
  }

  /** Verifies the access token from the connection URL's `token` query parameter, the same
   *  token issued to `AccessTokenGuard` for ordinary HTTP requests. */
  private authenticate(request: IncomingMessage): string | undefined {
    const token = new URL(request.url ?? '', 'ws://localhost').searchParams.get('token');
    if (!token) return undefined;
    try {
      return this.jwt.verify<AccessTokenPayload>(token).sub;
    } catch {
      return undefined;
    }
  }
}

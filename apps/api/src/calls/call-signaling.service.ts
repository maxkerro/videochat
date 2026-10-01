import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  CALL_EVENTS,
  callIceSchema,
  callInviteSchema,
  callMediaStateSchema,
  callRefSchema,
  callSdpSchema,
  makeEnvelope,
  type CallAccepted,
  type CallEndReason,
  type CallEnded,
  type CallIncoming,
  type CallRef,
  type WsEnvelope,
} from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Env } from '../config/env.js';
import { isBlocked } from '../db/blocks.js';
import {
  acceptCall,
  endCall,
  endExpiredCalls,
  findDirectPeer,
  findOpenCallForUser,
  getCall,
  handleConnectionGone,
  insertCall,
  peerConnectionOf,
  resumeCall,
} from '../db/calls.js';
import type { Database } from '../db/client.js';
import type { CallRow } from '../db/schema.js';
import { findUserById } from '../db/users.js';
import { DB, ENV } from '../infra/tokens.js';
import { RealtimeService, type RealtimeSocket } from '../realtime/realtime.service.js';
import { S3Service } from '../storage/s3.service.js';

/** How often each API node checks for calls whose ring timeout or reconnect grace has run out.
 *  The check is one indexed UPDATE; with several nodes sweeping, the conditional UPDATE means each
 *  expired call is still ended (and announced) exactly once. */
export const CALL_SWEEP_INTERVAL_MS = 1_000;

/** Fired after a call ends, once, by whichever node ended it (CHAT-044 posts call history). */
export type CallEndedListener = (call: CallRow) => Promise<void>;

/**
 * CHAT-041: WebRTC call signalling over the existing realtime socket.
 *
 * State lives in the `calls` table (see its schema comment); this service validates who may do
 * what, applies the transition, and tells the right sockets about it:
 *  - lifecycle events go to every device of both users (every callee device rings; every one
 *    stops when one answers -- "answered elsewhere");
 *  - offer/answer/ICE/media go only to the one connection on the other side of an active call.
 *
 * Authorisation: only a current member of a *direct* conversation can call into it, only the
 * callee can answer or decline, and negotiation is only relayed between the two connections the
 * call is bound to. Anything else is ignored -- like every other malformed realtime message.
 */
@Injectable()
export class CallSignalingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallSignalingService.name);
  private sweepTimer?: NodeJS.Timeout;
  private readonly endedListeners: CallEndedListener[] = [];

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly realtime: RealtimeService,
    private readonly s3: S3Service,
  ) {}

  onModuleInit(): void {
    this.realtime.registerInboundHandler('call.', (client, envelope) =>
      this.handle(client, envelope),
    );
    this.realtime.onDisconnect((client) => this.handleDisconnect(client));
    this.sweepTimer = setInterval(() => void this.sweep(), CALL_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  onCallEnded(listener: CallEndedListener): void {
    this.endedListeners.push(listener);
  }

  async handle(client: RealtimeSocket, envelope: WsEnvelope): Promise<void> {
    const userId = client.userId;
    const connectionId = client.connectionId;
    if (!userId || !connectionId) return;

    switch (envelope.type) {
      case CALL_EVENTS.invite:
        return this.invite(client, userId, connectionId, envelope.payload);
      case CALL_EVENTS.ringing:
        return this.ringing(userId, envelope.payload);
      case CALL_EVENTS.accept:
        return this.accept(userId, connectionId, envelope.payload);
      case CALL_EVENTS.decline:
        return this.hangUp(userId, envelope.payload, 'decline');
      case CALL_EVENTS.cancel:
        return this.hangUp(userId, envelope.payload, 'cancel');
      case CALL_EVENTS.end:
        return this.hangUp(userId, envelope.payload, 'end');
      case CALL_EVENTS.offer:
      case CALL_EVENTS.answer:
        return this.relay(connectionId, envelope.type, callSdpSchema, envelope.payload);
      case CALL_EVENTS.ice:
        return this.relay(connectionId, envelope.type, callIceSchema, envelope.payload);
      case CALL_EVENTS.media:
        return this.relay(connectionId, envelope.type, callMediaStateSchema, envelope.payload);
      case CALL_EVENTS.resume:
        return this.resume(userId, connectionId, envelope.payload);
      default:
        return;
    }
  }

  private async invite(
    client: RealtimeSocket,
    callerId: string,
    connectionId: string,
    payload: unknown,
  ): Promise<void> {
    const parsed = callInviteSchema.safeParse(payload);
    if (!parsed.success) return;
    const { callId, conversationId, media } = parsed.data;
    const refuse = (reason: CallEndReason) =>
      this.send(client, CALL_EVENTS.ended, { callId, reason } satisfies CallEnded);

    const callee = await findDirectPeer(this.db, conversationId, callerId);
    // Not a member, not a direct chat, or the other person left: there's no one to call.
    if (!callee) return refuse('unavailable');
    // Calling someone you've blocked: you know you blocked them, so say so plainly.
    if (await isBlocked(this.db, callerId, callee.id)) return refuse('unavailable');
    // Already in a call on another device/tab: one call at a time.
    if (await findOpenCallForUser(this.db, callerId)) return refuse('busy');

    // CHAT-021 "blocking is silent": if the callee blocked the caller, the call is created and
    // "rings" on the caller's side like any unanswered call, but the callee is never told.
    const silenced = await isBlocked(this.db, callee.id, callerId);
    const calleeBusy = !silenced && (await findOpenCallForUser(this.db, callee.id)) !== undefined;

    const call = await insertCall(this.db, {
      id: callId,
      conversationId,
      callerId,
      calleeId: callee.id,
      media,
      callerConnectionId: connectionId,
      silenced,
    });
    if (!call) return; // A retried invite for a call id that already exists.

    if (calleeBusy) {
      const ended = await endCall(this.db, call.id, 'busy', ['ringing']);
      if (ended) await this.announceEnded(ended);
      return;
    }
    if (silenced) return;

    const caller = await this.callerSummary(callerId, client);
    await this.realtime.publishToUser(
      callee.id,
      makeEnvelope<CallIncoming>(
        CALL_EVENTS.incoming,
        { callId, conversationId, media, caller },
        randomUUID(),
      ),
    );
  }

  /** A callee device is ringing: let the caller know (it shows "Ringing..." instead of "Calling..."). */
  private async ringing(userId: string, payload: unknown): Promise<void> {
    const ref = callRefSchema.safeParse(payload);
    if (!ref.success) return;
    const call = await getCall(this.db, ref.data.callId);
    if (!call || call.calleeId !== userId || call.status !== 'ringing' || call.silenced) return;
    await this.realtime.publishToConnection(
      call.callerConnectionId,
      makeEnvelope<CallRef>(CALL_EVENTS.ringing, { callId: call.id }, randomUUID()),
    );
  }

  private async accept(userId: string, connectionId: string, payload: unknown): Promise<void> {
    const ref = callRefSchema.safeParse(payload);
    if (!ref.success) return;
    const accepted = await acceptCall(this.db, ref.data.callId, userId, connectionId);
    if (accepted) {
      const event = makeEnvelope<CallAccepted>(
        CALL_EVENTS.accepted,
        { callId: accepted.id, connectionId },
        randomUUID(),
      );
      // Both users: the caller's device starts negotiating, and every *other* callee device sees
      // a connectionId that isn't its own and stops ringing ("answered elsewhere").
      await Promise.all([
        this.realtime.publishToUser(accepted.calleeId, event),
        this.realtime.publishToUser(accepted.callerId, event),
      ]);
      return;
    }
    // Lost the race: tell just this device what happened instead.
    const current = await getCall(this.db, ref.data.callId);
    if (!current || current.calleeId !== userId) return;
    if (current.status === 'active' && current.calleeConnectionId) {
      await this.realtime.publishToConnection(
        connectionId,
        makeEnvelope<CallAccepted>(
          CALL_EVENTS.accepted,
          { callId: current.id, connectionId: current.calleeConnectionId },
          randomUUID(),
        ),
      );
    } else if (current.status === 'ended' && current.endReason) {
      await this.realtime.publishToConnection(
        connectionId,
        makeEnvelope<CallEnded>(
          CALL_EVENTS.ended,
          { callId: current.id, reason: current.endReason },
          randomUUID(),
        ),
      );
    }
  }

  /**
   * decline/cancel/end. Each maps to the right transition for who's asking and what state the
   * call is in, so a client that sends `end` while the call is still ringing (the caller hanging
   * up fast) still gets the right outcome.
   */
  private async hangUp(
    userId: string,
    payload: unknown,
    action: 'decline' | 'cancel' | 'end',
  ): Promise<void> {
    const ref = callRefSchema.safeParse(payload);
    if (!ref.success) return;
    const call = await getCall(this.db, ref.data.callId);
    if (!call || call.status === 'ended') return;
    const isCaller = call.callerId === userId;
    const isCallee = call.calleeId === userId;
    if (!isCaller && !isCallee) return;

    let ended: CallRow | undefined;
    if (call.status === 'ringing') {
      if (isCaller && action !== 'decline') {
        ended = await endCall(this.db, call.id, 'cancelled', ['ringing']);
      } else if (isCallee && action !== 'cancel' && !call.silenced) {
        ended = await endCall(this.db, call.id, 'declined', ['ringing']);
      }
    } else if (action === 'end') {
      ended = await endCall(this.db, call.id, 'completed', ['active']);
    }
    if (ended) await this.announceEnded(ended);
  }

  /** offer/answer/ICE/media: forwarded verbatim (after validation) to the other connection. */
  private async relay<S extends z.ZodType<{ callId: string }>>(
    connectionId: string,
    type: string,
    schema: S,
    payload: unknown,
  ): Promise<void> {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return;
    const call = await getCall(this.db, parsed.data.callId);
    if (!call) return;
    const peer = peerConnectionOf(call, connectionId);
    if (!peer) return;
    await this.realtime.publishToConnection(peer, makeEnvelope(type, parsed.data, randomUUID()));
  }

  /** CHAT-043: a participant's socket reconnected; bind the call to the new connection and tell
   *  the other side, which renegotiates (ICE restart) over it. */
  private async resume(userId: string, connectionId: string, payload: unknown): Promise<void> {
    const ref = callRefSchema.safeParse(payload);
    if (!ref.success) return;
    const resumed = await resumeCall(this.db, ref.data.callId, userId, connectionId);
    if (!resumed) {
      const current = await getCall(this.db, ref.data.callId);
      if (current && current.status === 'ended' && current.endReason) {
        await this.realtime.publishToConnection(
          connectionId,
          makeEnvelope<CallEnded>(
            CALL_EVENTS.ended,
            { callId: current.id, reason: current.endReason },
            randomUUID(),
          ),
        );
      }
      return;
    }
    const peer = peerConnectionOf(resumed, connectionId);
    const event = makeEnvelope<CallRef>(CALL_EVENTS.resume, { callId: resumed.id }, randomUUID());
    await Promise.all([
      this.realtime.publishToConnection(connectionId, event),
      peer ? this.realtime.publishToConnection(peer, event) : Promise.resolve(),
    ]);
  }

  private async handleDisconnect(client: RealtimeSocket): Promise<void> {
    if (!client.connectionId) return;
    const { cancelled } = await handleConnectionGone(this.db, client.connectionId);
    for (const call of cancelled) await this.announceEnded(call);
  }

  /** Ends calls whose ring timeout or reconnect grace has passed. Public for tests. */
  async sweep(now: Date = new Date()): Promise<void> {
    try {
      const expired = await endExpiredCalls(
        this.db,
        now,
        this.env.CALL_RING_TIMEOUT_SEC,
        this.env.CALL_RECONNECT_GRACE_SEC,
      );
      for (const call of expired) await this.announceEnded(call);
    } catch (err) {
      // A DB blip shouldn't crash the node; the next sweep picks the same calls up.
      this.logger.warn(`Call sweep failed: ${(err as Error).message}`);
    }
  }

  private async announceEnded(call: CallRow): Promise<void> {
    if (!call.endReason) return;
    const event = makeEnvelope<CallEnded>(
      CALL_EVENTS.ended,
      { callId: call.id, reason: call.endReason },
      randomUUID(),
    );
    await Promise.all([
      this.realtime.publishToUser(call.callerId, event),
      // A silenced call (callee blocked the caller) was never shown to the callee.
      call.silenced ? Promise.resolve() : this.realtime.publishToUser(call.calleeId, event),
    ]);
    for (const listener of this.endedListeners) {
      await listener(call).catch((err: Error) => {
        this.logger.warn(`Call-ended listener failed for ${call.id}: ${err.message}`);
      });
    }
  }

  private async callerSummary(
    callerId: string,
    client: RealtimeSocket,
  ): Promise<CallIncoming['caller']> {
    const row = await findUserById(this.db, callerId);
    return {
      id: callerId,
      displayName: row?.displayName ?? client.displayName ?? '',
      avatarUrl: row ? await this.s3.getAvatarUrl(row.avatarKey) : null,
    };
  }

  private send(client: RealtimeSocket, type: string, payload: unknown): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(makeEnvelope(type, payload, randomUUID())));
    }
  }
}

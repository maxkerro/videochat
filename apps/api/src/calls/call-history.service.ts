import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { makeEnvelope, type CallMessageMeta } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { isConversationMember, markConversationRead } from '../db/conversations.js';
import { appendMessageWithStatus, SenderNotAMemberError } from '../db/messages.js';
import type { CallRow } from '../db/schema.js';
import { DB } from '../infra/tokens.js';
import { toMessage } from '../messages/message-mapper.js';
import { publishReadEvent } from '../conversations/read-events.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CallSignalingService } from './call-signaling.service.js';

/** How a call's end reason reads in the conversation history. */
export function callOutcome(call: CallRow): CallMessageMeta['outcome'] | null {
  switch (call.endReason) {
    case 'missed':
    case 'cancelled':
    case 'busy':
      return 'missed';
    case 'declined':
      return 'declined';
    case 'completed':
    case 'connection-lost':
      return call.answeredAt ? 'completed' : 'missed';
    default:
      // `unavailable` never got as far as ringing anyone; nothing to record.
      return null;
  }
}

export function formatCallDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Plain-text summary stored as the message body: what older clients, search and anything that
 *  doesn't understand `call` messages will show. Clients that do, word it per participant. */
export function callSummaryText(meta: CallMessageMeta): string {
  const kind = meta.media === 'video' ? 'video call' : 'audio call';
  const Kind = kind[0]!.toUpperCase() + kind.slice(1);
  switch (meta.outcome) {
    case 'missed':
      return `Missed ${kind}`;
    case 'declined':
      return `Declined ${kind}`;
    case 'completed':
      return meta.durationSec ? `${Kind} · ${formatCallDuration(meta.durationSec)}` : Kind;
  }
}

/**
 * CHAT-044: when a call ends, posts it into the conversation ("Missed video call",
 * "Video call · 12:34") through the ordinary message pipeline, so it shows in history, the inbox
 * preview and the unread count like any other message, and clients can offer "Call back" on it.
 *
 * The message is attributed to the caller. A *missed* call stays unread for the callee -- that's
 * the point of it. A call the callee answered or declined isn't news to them, so it's marked read
 * for them straight away.
 *
 * Each call ends exactly once (the conditional UPDATE in CallSignalingService), so this runs once
 * per call no matter how many API nodes there are.
 */
@Injectable()
export class CallHistoryService implements OnModuleInit {
  private readonly logger = new Logger(CallHistoryService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly signaling: CallSignalingService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.signaling.onCallEnded((call) => this.record(call));
  }

  async record(call: CallRow): Promise<void> {
    // CHAT-021: a call from someone the callee blocked was never shown to them; don't leave a
    // trace of it in their conversation either.
    if (call.silenced || !call.endReason) return;
    const outcome = callOutcome(call);
    if (!outcome) return;

    const meta: CallMessageMeta = {
      callId: call.id,
      media: call.media,
      outcome,
      endReason: call.endReason,
      callerId: call.callerId,
      durationSec:
        outcome === 'completed' && call.answeredAt && call.endedAt
          ? Math.max(0, Math.round((call.endedAt.getTime() - call.answeredAt.getTime()) / 1000))
          : null,
    };

    const result = await this.append(call, meta);
    // Nothing written (no member left), or this call's entry already existed: in the latter case
    // it was already announced, so don't re-publish it or re-mark anything read.
    if (!result?.created) return;
    const { row } = result;
    const message = toMessage(row);
    await this.realtime.publishToConversation(
      call.conversationId,
      makeEnvelope('message.new', message, message.id),
    );

    // CHAT-035: a missed call is worth a push (the callee wasn't there to see it ring).
    if (outcome === 'missed') void this.notifications.notifyMissedCall(call);

    if (outcome !== 'missed') {
      const updated = await markConversationRead(
        this.db,
        call.conversationId,
        call.calleeId,
        row.seq,
      );
      if (updated) {
        await publishReadEvent(this.db, this.realtime, {
          conversationId: call.conversationId,
          userId: call.calleeId,
          lastReadSeq: updated.lastReadSeq,
        });
      }
    }
  }

  private async append(call: CallRow, meta: CallMessageMeta) {
    const input = {
      conversationId: call.conversationId,
      body: callSummaryText(meta),
      type: 'call' as const,
      meta: { call: meta },
    };
    try {
      // Idempotent: `(sender_id, client_msg_id)` is unique and appendMessage returns the existing
      // row for a repeat, so even if this ever ran twice for one call (a retry, a listener
      // registered twice) it can't post a duplicate entry or inflate the unread count.
      return await appendMessageWithStatus(this.db, {
        ...input,
        senderId: call.callerId,
        clientMsgId: `call:${call.id}`,
      });
    } catch (err) {
      if (!(err instanceof SenderNotAMemberError)) throw err;
    }
    // The caller left the conversation while the call was ringing. A null-sender entry skips
    // appendMessage's sender-membership check, so only write it if the conversation still has
    // the callee as a current member -- otherwise there's nobody left for whom it means anything.
    // (A null sender also isn't covered by the uniqueness index above; this path is rare enough
    // that a theoretical duplicate is acceptable.)
    if (!(await isConversationMember(this.db, call.conversationId, call.calleeId))) {
      return undefined;
    }
    this.logger.debug(`Caller no longer a member; recording call ${call.id} as a system entry`);
    return appendMessageWithStatus(this.db, { ...input, senderId: null });
  }
}

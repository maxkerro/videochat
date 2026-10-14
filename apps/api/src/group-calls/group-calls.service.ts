import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  GROUP_CALL_EVENTS,
  GROUP_CALL_MAX_PARTICIPANTS,
  groupCallDurationText,
  makeEnvelope,
  type GroupCall,
  type GroupCallJoin,
  type GroupCallUpdated,
} from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { findConversationForUser } from '../db/conversations.js';
import {
  endGroupCalls,
  findRunningGroupCall,
  listRunningGroupCalls,
  setGroupCallParticipants,
  startOrGetGroupCall,
} from '../db/group-calls.js';
import { appendMessage } from '../db/messages.js';
import type { GroupCallRow } from '../db/schema.js';
import { findUserById } from '../db/users.js';
import { DB } from '../infra/tokens.js';
import { toMessage } from '../messages/message-mapper.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { connectionIdentity, SFU, type Sfu } from './sfu.js';

/** How often each API node asks the SFU which calls are still going and how many are in them. */
export const GROUP_CALL_SWEEP_INTERVAL_MS = 5_000;
/** A new call whose room the SFU doesn't list yet is left alone this long (creation can lag). */
export const GROUP_CALL_START_GRACE_MS = 30_000;

export function toGroupCall(row: GroupCallRow): GroupCall {
  return {
    id: row.id,
    conversationId: row.conversationId,
    startedBy: row.startedBy,
    startedAt: row.startedAt.toISOString(),
    participantCount: row.participantCount,
  };
}

/**
 * CHAT-070: group calls in group conversations. The API decides who may join which call and hands
 * out a short-lived room token; the SFU carries the media. A call ends when its SFU room is gone
 * (the SFU closes a room shortly after the last person leaves), which the sweep notices.
 */
@Injectable()
export class GroupCallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GroupCallsService.name);
  private timer?: NodeJS.Timeout;
  private sweepFailing = false;
  private sweeping = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SFU) private readonly sfu: Sfu,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    if (!this.sfu.enabled) return;
    this.timer = setInterval(() => void this.sweep(), GROUP_CALL_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  get enabled(): boolean {
    return this.sfu.enabled;
  }

  /** The call running in a group, for a member (null when none). */
  async running(conversationId: string, userId: string): Promise<GroupCall | null> {
    await this.requireGroupMember(conversationId, userId);
    const row = await findRunningGroupCall(this.db, conversationId);
    return row ? toGroupCall(row) : null;
  }

  /** Starts the group's call, or joins the one already running. */
  async join(conversationId: string, userId: string): Promise<GroupCallJoin> {
    await this.requireGroupMember(conversationId, userId);
    if (!this.sfu.enabled) throw new ServiceUnavailableException('Group calls are not set up');

    const { call, created } = await startOrGetGroupCall(this.db, conversationId, userId);
    const user = await findUserById(this.db, userId);
    const name = user?.displayName ?? 'Someone';
    if (!created && call.participantCount >= GROUP_CALL_MAX_PARTICIPANTS) {
      // The count can be a few seconds old; the room's own 20-person limit is the hard stop.
      throw new ConflictException(
        `The call is full (${GROUP_CALL_MAX_PARTICIPANTS} people at most)`,
      );
    }
    try {
      // Also for a running call: the SFU may have closed its room a moment before the sweep
      // noticed, and a room it re-creates on join would lack our settings (the 20-person cap).
      // Creating an existing room just returns it.
      await this.sfu.createRoom(call.id);
    } catch (err) {
      this.logger.warn(`Couldn't create the SFU room for ${call.id}: ${(err as Error).message}`);
      // No room, no call: a call this request created is taken back so the next try starts afresh.
      if (created) await endGroupCalls(this.db, [call.id]);
      throw new ServiceUnavailableException('Couldn’t start the call. Please try again.');
    }
    if (created) {
      // The call is running either way; a failed announcement must not fail the request.
      try {
        await this.postSystemMessage(conversationId, `${name} started a group call`);
        await this.announce(conversationId, call);
      } catch (err) {
        this.logger.warn(`Couldn't announce group call ${call.id}: ${(err as Error).message}`);
      }
    }
    const token = await this.sfu.joinToken(call.id, connectionIdentity(userId, randomUUID()), name);
    return { call: toGroupCall(call), url: this.sfu.url, token };
  }

  /**
   * Someone left the group or was removed: take them out of its running call too. Their token was
   * checked against membership only when issued, and the SFU renews it for as long as they stay.
   */
  async removeFromCall(conversationId: string, userId: string): Promise<void> {
    if (!this.sfu.enabled) return;
    try {
      const call = await findRunningGroupCall(this.db, conversationId);
      if (call) await this.sfu.removeUser(call.id, userId);
    } catch (err) {
      this.logger.warn(
        `Couldn't remove ${userId} from the group call in ${conversationId}: ${(err as Error).message}`,
      );
    }
  }

  /** Brings each running call in line with the SFU: new participant counts, and ends the calls
   *  whose room is gone. Public for tests. */
  async sweep(now: Date = new Date()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const running = await listRunningGroupCalls(this.db);
      if (running.length === 0) return;
      const rooms = new Map(
        (await this.sfu.listRooms(running.map((c) => c.id))).map((r) => [
          r.name,
          r.numParticipants,
        ]),
      );
      if (this.sweepFailing) {
        this.sweepFailing = false;
        this.logger.log('Group call sweep recovered');
      }
      const gone = running.filter(
        (c) =>
          !rooms.has(c.id) && now.getTime() - c.startedAt.getTime() >= GROUP_CALL_START_GRACE_MS,
      );
      for (const call of await endGroupCalls(
        this.db,
        gone.map((c) => c.id),
        now,
      )) {
        await this.announceEnded(call);
      }
      for (const call of running) {
        const count = rooms.get(call.id);
        if (count === undefined) continue;
        const changed = await setGroupCallParticipants(this.db, call.id, count);
        if (changed) await this.announce(changed.conversationId, changed);
      }
    } catch (err) {
      // Nothing was ended (the SFU couldn't be asked); the next sweep tries again.
      if (!this.sweepFailing) {
        this.sweepFailing = true;
        this.logger.warn(`Group call sweep failing (logged once): ${(err as Error).message}`);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async announceEnded(call: GroupCallRow): Promise<void> {
    try {
      const seconds = ((call.endedAt ?? new Date()).getTime() - call.startedAt.getTime()) / 1000;
      await this.postSystemMessage(
        call.conversationId,
        `Group call ended · ${groupCallDurationText(seconds)}`,
      );
      await this.announce(call.conversationId, null);
    } catch (err) {
      this.logger.warn(
        `Couldn't announce the end of group call ${call.id}: ${(err as Error).message}`,
      );
    }
  }

  private async announce(conversationId: string, call: GroupCallRow | null): Promise<void> {
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope<GroupCallUpdated>(
        GROUP_CALL_EVENTS.updated,
        { conversationId, call: call ? toGroupCall(call) : null },
        randomUUID(),
      ),
    );
  }

  private async postSystemMessage(conversationId: string, body: string): Promise<void> {
    const row = await appendMessage(this.db, {
      conversationId,
      senderId: null,
      body,
      type: 'system',
    });
    const message = toMessage(row);
    await this.realtime.publishToConversation(
      conversationId,
      makeEnvelope('message.new', message, message.id),
    );
  }

  /** 404 for anyone outside the conversation (never revealing it exists), 400 for a direct chat
   *  (those have 1:1 calls). */
  private async requireGroupMember(conversationId: string, userId: string): Promise<void> {
    const row = await findConversationForUser(this.db, conversationId, userId);
    if (!row) throw new NotFoundException('Conversation not found');
    if (row.type !== 'group') throw new BadRequestException('Group calls are for group chats');
  }
}

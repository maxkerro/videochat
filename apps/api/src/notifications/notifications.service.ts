import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { clientViewingSchema, type PushPayload, type WsEnvelope } from '@videochat/shared';
import { Redis } from 'ioredis';
import { isBlocked } from '../db/blocks.js';
import type { Database } from '../db/client.js';
import { findConversationForUser, listNotifiableMembers } from '../db/conversations.js';
import { deletePushDevice, listPushDevices } from '../db/devices.js';
import type { CallRow, MessageRow } from '../db/schema.js';
import { findUserById } from '../db/users.js';
import { DB, REDIS } from '../infra/tokens.js';
import { RealtimeService, type RealtimeSocket } from '../realtime/realtime.service.js';
import { PUSH_CHANNELS, type PushChannel } from './push-channel.js';

const VIEWING_TTL_SEC = 2 * 60 * 60;
const viewingKey = (userId: string) => `viewing:${userId}`;
const PREVIEW_MAX = 140;

/** What a notification says about a message. */
export function notificationText(row: Pick<MessageRow, 'type' | 'body' | 'meta'>): string {
  const attachment = row.meta?.attachment;
  const caption = row.body ? `: ${row.body}` : '';
  const text =
    attachment?.kind === 'image'
      ? `Photo${caption}`
      : attachment
        ? `${attachment.filename}${caption}`
        : (row.body ?? 'New message');
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/**
 * CHAT-035: push notifications for new messages (and missed calls), to members who
 * - aren't the sender,
 * - haven't muted the conversation,
 * - aren't looking at that conversation right now in any tab (tabs report what they show while
 *   visible and focused as `client.viewing`; kept per connection in Redis so every API node
 *   sees every tab).
 * Delivery goes through whichever {@link PushChannel} serves each device's platform; dead
 * subscriptions are removed as soon as a push service says so.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly channels: Map<string, PushChannel>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
    @Inject(PUSH_CHANNELS) channels: PushChannel[],
  ) {
    this.channels = new Map(channels.map((c) => [c.platform, c]));
  }

  onModuleInit(): void {
    this.realtime.registerInboundHandler('client.', (client, envelope) =>
      this.handleClientEnvelope(client, envelope),
    );
    this.realtime.onDisconnect(async (client) => {
      if (client.userId && client.connectionId) {
        await this.redis.hdel(viewingKey(client.userId), client.connectionId).catch(() => 0);
      }
    });
  }

  get enabled(): boolean {
    return [...this.channels.values()].some((c) => c.enabled);
  }

  async notifyNewMessage(row: MessageRow): Promise<void> {
    if (!this.enabled || row.type === 'system' || row.type === 'call' || !row.senderId) return;
    try {
      const recipients = await this.recipients(row.conversationId, row.senderId);
      if (!recipients.length) return;
      const sender = await findUserById(this.db, row.senderId);
      const senderName = sender?.displayName ?? 'Someone';
      const conversation = await findConversationForUser(
        this.db,
        row.conversationId,
        recipients[0]!,
      );
      const title =
        conversation?.type === 'group' && conversation.title
          ? `${senderName} · ${conversation.title}`
          : senderName;
      await this.push(recipients, {
        title,
        body: notificationText(row),
        conversationId: row.conversationId,
        url: `/c/${row.conversationId}`,
        tag: `conv-${row.conversationId}`,
      });
    } catch (err) {
      this.logger.warn(`Notifying about message ${row.id} failed: ${(err as Error).message}`);
    }
  }

  /** CHAT-044's "a missed call triggers a notification", now that there's push. */
  async notifyMissedCall(call: CallRow): Promise<void> {
    if (!this.enabled || call.silenced) return;
    try {
      const recipients = (await this.recipients(call.conversationId, call.callerId)).filter(
        (id) => id === call.calleeId,
      );
      if (!recipients.length) return;
      const caller = await findUserById(this.db, call.callerId);
      await this.push(recipients, {
        title: caller?.displayName ?? 'Missed call',
        body: call.media === 'video' ? 'Missed video call' : 'Missed audio call',
        conversationId: call.conversationId,
        url: `/c/${call.conversationId}`,
        tag: `call-${call.id}`,
      });
    } catch (err) {
      this.logger.warn(`Notifying about missed call ${call.id} failed: ${(err as Error).message}`);
    }
  }

  /** Members to notify: not the sender, not muted, not viewing it, and not blocking the sender. */
  private async recipients(conversationId: string, senderId: string): Promise<string[]> {
    const members = await listNotifiableMembers(this.db, conversationId, senderId);
    const result: string[] = [];
    for (const userId of members) {
      const viewing = await this.redis.hvals(viewingKey(userId)).catch(() => [] as string[]);
      if (viewing.includes(conversationId)) continue;
      if (await isBlocked(this.db, userId, senderId)) continue;
      result.push(userId);
    }
    return result;
  }

  private async push(userIds: string[], payload: PushPayload): Promise<void> {
    const devices = await listPushDevices(this.db, userIds);
    await Promise.all(
      devices.map(async (device) => {
        const channel = this.channels.get(device.platform);
        if (!channel?.enabled) return;
        const result = await channel.send(device, payload);
        if (result === 'gone') await deletePushDevice(this.db, device.token);
      }),
    );
  }

  private async handleClientEnvelope(client: RealtimeSocket, envelope: WsEnvelope): Promise<void> {
    if (envelope.type !== 'client.viewing' || !client.userId || !client.connectionId) return;
    const parsed = clientViewingSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const key = viewingKey(client.userId);
    const { conversationId } = parsed.data;
    // Only a conversation the socket belongs to counts -- a client can't claim to be viewing
    // someone else's conversation (it would only suppress its own pushes, but still).
    if (conversationId && client.conversationIds?.has(conversationId)) {
      await this.redis
        .multi()
        .hset(key, client.connectionId, conversationId)
        .expire(key, VIEWING_TTL_SEC)
        .exec();
    } else {
      await this.redis.hdel(key, client.connectionId);
    }
  }
}

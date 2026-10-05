import { makeEnvelope, type ConversationReadEvent } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/client.js';
import { findUserById, listReadReceiptMemberIds } from '../db/users.js';
import type { RealtimeService } from '../realtime/realtime.service.js';

/**
 * CHAT-019 + CHAT-037: announces someone's new read position. Normally to the members who have
 * read receipts on themselves -- receipts are reciprocal, so a member with them off doesn't get
 * other people's either -- plus the reader's own devices. With the reader's receipts off, only to
 * their own devices (their unread state still syncs, but nobody else learns what they've read).
 */
export async function publishReadEvent(
  db: DbExecutor,
  realtime: RealtimeService,
  event: ConversationReadEvent,
): Promise<void> {
  const envelope = makeEnvelope<ConversationReadEvent>('conversation.read', event, randomUUID());
  const reader = await findUserById(db, event.userId);
  if (reader && !reader.readReceipts) {
    await realtime.publishToUser(event.userId, envelope);
    return;
  }
  const viewers = await listReadReceiptMemberIds(db, event.conversationId);
  const recipients = new Set([event.userId, ...viewers]);
  await Promise.all([...recipients].map((id) => realtime.publishToUser(id, envelope)));
}

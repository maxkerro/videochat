import { makeEnvelope, type ConversationReadEvent } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/client.js';
import { findUserById } from '../db/users.js';
import type { RealtimeService } from '../realtime/realtime.service.js';

/**
 * CHAT-019 + CHAT-037: announces someone's new read position. Normally to the whole conversation
 * ("Seen"); with read receipts off, only to that person's own devices (their unread state still
 * syncs, but nobody else learns what they've read).
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
  } else {
    await realtime.publishToConversation(event.conversationId, envelope);
  }
}

import type { ConversationSummary } from '@videochat/shared';
import type { ConversationListRow, ConversationWithMembership } from '../db/conversations.js';
import { toPublicUser } from '../users/user-mapper.js';

/** Shapes a DB conversation row (plus optional direct-conversation peer) into the API contract. */
export function toConversationSummary(
  row: ConversationWithMembership | ConversationListRow,
  peerAvatarUrl: string | null,
): ConversationSummary {
  const peer = 'peer' in row && row.peer ? toPublicUser(row.peer, peerAvatarUrl) : null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    lastSeq: row.lastSeq,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    role: row.role,
    lastReadSeq: row.lastReadSeq,
    peer,
  };
}

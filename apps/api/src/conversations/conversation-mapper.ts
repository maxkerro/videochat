import type { ConversationSummary } from '@videochat/shared';
import type { ConversationListRow, ConversationWithMembership } from '../db/conversations.js';
import { toPublicUser } from '../users/user-mapper.js';

/** Shapes a DB conversation row (plus optional direct-conversation peer) into the API contract. */
export function toConversationSummary(
  row: ConversationWithMembership | ConversationListRow,
  peerAvatarUrl: string | null,
): ConversationSummary {
  const peer = 'peer' in row && row.peer ? toPublicUser(row.peer, peerAvatarUrl) : null;
  // CHAT-019: only ever meaningful for a direct conversation with a known peer -- `undefined`
  // (peer loaded, but its `lastReadSeq` wasn't, e.g. `findOrCreateDirectConversation`'s freshly
  // created/found row) falls back to 0 rather than null, since a brand-new peer genuinely hasn't
  // read anything yet. A group (no `peer` at all) always reports `null`: "Seen by N" for a group
  // comes from the members endpoint instead, not this single value.
  const peerLastReadSeq = peer
    ? (('peerLastReadSeq' in row ? row.peerLastReadSeq : undefined) ?? 0)
    : null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    lastSeq: row.lastSeq,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    role: row.role,
    lastReadSeq: row.lastReadSeq,
    peer,
    peerLastReadSeq,
  };
}

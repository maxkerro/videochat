import type { ConversationSummary } from '@videochat/shared';
import type { ConversationListRow, ConversationWithMembership } from '../db/conversations.js';
import type { MessageRow } from '../db/schema.js';
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
    muted: !!row.mutedUntil && row.mutedUntil.getTime() > Date.now(),
    peer,
    peerLastReadSeq,
    lastMessage: toLastMessagePreview('lastMessage' in row ? row.lastMessage : undefined),
  };
}

/** CHAT-044: just what the inbox preview line needs, not the whole message. */
function toLastMessagePreview(row: MessageRow | undefined): ConversationSummary['lastMessage'] {
  if (!row) return null;
  return {
    type: row.type,
    senderId: row.senderId,
    body: row.deletedAt ? null : row.body,
    // A deleted call entry previews as "Message deleted", not as the call it used to describe.
    ...(row.type === 'call' && row.meta?.call && !row.deletedAt ? { call: row.meta.call } : {}),
    ...(row.meta?.attachment && !row.deletedAt
      ? { attachment: { kind: row.meta.attachment.kind, filename: row.meta.attachment.filename } }
      : {}),
  };
}

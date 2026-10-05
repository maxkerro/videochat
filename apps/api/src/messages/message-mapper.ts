import type { Message } from '@videochat/shared';
import type { MessageRow } from '../db/schema.js';

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    senderId: row.senderId,
    clientMsgId: row.clientMsgId,
    type: row.type,
    // Deletion isn't implemented yet (that's a later story), but blank the body now rather than
    // leaving a landmine: whenever `deletedAt` starts getting set, a deleted message must not
    // keep serving its original text to every client that fetches history after the fact.
    body: row.deletedAt ? null : row.body,
    replyToId: row.replyToId,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // CHAT-044: only call messages carry this, so every other message keeps its exact shape.
    ...(row.type === 'call' && row.meta?.call ? { call: row.meta.call } : {}),
    // CHAT-030: a deleted message's file is gone with it.
    ...((row.type === 'image' || row.type === 'file') && row.meta?.attachment && !row.deletedAt
      ? { attachment: row.meta.attachment }
      : {}),
    ...(row.type === 'text' && row.meta?.linkPreview && !row.deletedAt
      ? { linkPreview: row.meta.linkPreview }
      : {}),
  };
}

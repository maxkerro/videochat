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
  };
}

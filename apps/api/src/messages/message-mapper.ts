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
    body: row.body,
    replyToId: row.replyToId,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

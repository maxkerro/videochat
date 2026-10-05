import { LIMITS, type Message, type ReplyPreview } from '@videochat/shared';
import type { DbExecutor } from '../db/client.js';
import { findMessagesByIds } from '../db/messages.js';
import type { MessageRow } from '../db/schema.js';

/** CHAT-032: what a reply shows of its original -- nothing of the content once it's deleted. */
export function toReplyPreview(target: MessageRow): ReplyPreview {
  const deleted = target.deletedAt !== null;
  const body = deleted ? null : target.body;
  return {
    id: target.id,
    seq: target.seq,
    senderId: target.senderId,
    type: target.type,
    snippet:
      body === null
        ? null
        : body.length > LIMITS.replySnippetLength
          ? `${body.slice(0, LIMITS.replySnippetLength)}…`
          : body,
    ...(!deleted && target.meta?.attachment
      ? {
          attachment: {
            kind: target.meta.attachment.kind,
            filename: target.meta.attachment.filename,
          },
        }
      : {}),
    deleted,
  };
}

/**
 * Maps rows to API messages, with each reply's quote of its original loaded in one query. Use
 * this (not bare `toMessage`) for anything that could be a reply, so a `message.updated` never
 * replaces a message with a version missing its quote.
 */
export async function toMessages(db: DbExecutor, rows: MessageRow[]): Promise<Message[]> {
  const ids = [...new Set(rows.map((r) => r.replyToId).filter((id): id is string => !!id))];
  const targets = new Map((await findMessagesByIds(db, ids)).map((t) => [t.id, t]));
  return rows.map((row) => {
    const target = row.replyToId ? targets.get(row.replyToId) : undefined;
    // Same conversation only -- the send path checks this, and so does the read path.
    return toMessage(
      row,
      target && target.conversationId === row.conversationId ? target : undefined,
    );
  });
}

export async function toMessageWithReply(db: DbExecutor, row: MessageRow): Promise<Message> {
  return (await toMessages(db, [row]))[0]!;
}

export function toMessage(row: MessageRow, replyTarget?: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    senderId: row.senderId,
    clientMsgId: row.clientMsgId,
    type: row.type,
    // CHAT-032: a deleted message's body is wiped in the database too; this is belt and braces.
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
    ...(replyTarget && !row.deletedAt ? { replyTo: toReplyPreview(replyTarget) } : {}),
  };
}

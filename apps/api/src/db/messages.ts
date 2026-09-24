import { and, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { MessageType } from '@videochat/shared';
import type { Database, DbExecutor } from './client.js';
import { conversations, messages, type MessageRow } from './schema.js';

export interface AppendMessageInput {
  conversationId: string;
  senderId: string | null;
  body: string | null;
  type?: MessageType;
  clientMsgId?: string | null;
  replyToId?: string | null;
}

/**
 * Appends a message and assigns the next per-conversation `seq`.
 *
 * `UPDATE conversations SET last_seq = last_seq + 1 ... RETURNING` takes a row lock on the
 * conversation, so concurrent appends to the same conversation serialise and never collide,
 * while appends to different conversations run in parallel.
 *
 * Idempotent on (senderId, clientMsgId): a retry returns the original message instead of a
 * duplicate. This is the foundation for CHAT-014's optimistic send and retry.
 */
export async function appendMessage(db: Database, input: AppendMessageInput): Promise<MessageRow> {
  return db.transaction(async (tx) => {
    if (input.senderId && input.clientMsgId) {
      const existing = await findByClientMsgId(tx, input.senderId, input.clientMsgId);
      if (existing) return existing;
    }

    const [conv] = await tx
      .update(conversations)
      .set({ lastSeq: sql`${conversations.lastSeq} + 1`, lastMessageAt: sql`now()` })
      .where(eq(conversations.id, input.conversationId))
      .returning({ seq: conversations.lastSeq });
    if (!conv) throw new Error(`Conversation ${input.conversationId} not found`);

    const [row] = await tx
      .insert(messages)
      .values({
        id: ulid(),
        conversationId: input.conversationId,
        seq: conv.seq,
        senderId: input.senderId,
        clientMsgId: input.clientMsgId ?? null,
        type: input.type ?? 'text',
        body: input.body,
        replyToId: input.replyToId ?? null,
      })
      .returning();
    return row!;
  });
}

async function findByClientMsgId(
  db: DbExecutor,
  senderId: string,
  clientMsgId: string,
): Promise<MessageRow | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.senderId, senderId), eq(messages.clientMsgId, clientMsgId)))
    .limit(1);
  return row;
}

/**
 * The most recent `limit` messages in a conversation, oldest first (ready to render top-to-
 * bottom). A minimal stand-in for CHAT-016's cursor-paged, virtualized history -- just enough
 * to show a working conversation for CHAT-014's send/receive.
 */
export async function listRecentMessages(
  db: DbExecutor,
  conversationId: string,
  limit: number,
): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

/** Stable key for a direct conversation between two users, order-independent. */
export function directKeyFor(userA: string, userB: string): string {
  if (userA === userB) throw new Error('A direct conversation needs two different users');
  return [userA, userB].sort().join(':');
}

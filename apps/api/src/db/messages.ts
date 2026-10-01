import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { MessageType } from '@videochat/shared';
import type { Database, DbExecutor } from './client.js';
import { conversations, memberships, messages, type MessageRow } from './schema.js';

/** Thrown by {@link appendMessage} when `senderId` is no longer (or never was) an active member
 *  of the conversation, checked *inside* the same transaction as the insert (see the comment on
 *  that check for why). Callers map this to whatever "not found"/"forbidden" shape their layer
 *  uses -- e.g. `MessagesService.send` turns it into a 404, matching the "member-only access"
 *  pattern used everywhere else, and never leaking that the conversation exists to someone just
 *  removed from it. */
export class SenderNotAMemberError extends Error {
  constructor(conversationId: string) {
    super(`Sender is not an active member of conversation ${conversationId}`);
    this.name = 'SenderNotAMemberError';
  }
}

export interface AppendMessageInput {
  conversationId: string;
  senderId: string | null;
  body: string | null;
  type?: MessageType;
  clientMsgId?: string | null;
  replyToId?: string | null;
  /** CHAT-044: structured data for non-text types (see the `meta` column). */
  meta?: MessageRow['meta'];
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

    // CHAT-018: authoritative membership check, *inside* this transaction rather than left to the
    // caller, and after confirming the conversation itself exists (so a bad conversationId still
    // fails with the plain "not found" above, not this). A caller-side check (e.g.
    // `MessagesService.send`'s own `requireMember`, still done first as a fast-path that avoids
    // opening a transaction at all for the common non-member case) has a real race now that group
    // leave/kick exist: someone removed between that check and this insert could otherwise still
    // get one more message in. `senderId` is null for system messages ("Anna added Ben"), which
    // aren't authored by a member and so skip this entirely.
    if (input.senderId) {
      const [membership] = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.conversationId, input.conversationId),
            eq(memberships.userId, input.senderId),
            isNull(memberships.leftAt),
          ),
        )
        .limit(1);
      if (!membership) throw new SenderNotAMemberError(input.conversationId);
    }

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
        meta: input.meta ?? null,
      })
      .returning();

    if (input.senderId) {
      // Sending a message counts as having read up to it -- without this, the sender's own
      // lastReadSeq never advances, and their own conversation list would show it as unread.
      // GREATEST rather than a plain assignment: today the conversation row lock above already
      // serializes seq allocation, so conv.seq can only ever be higher than what's stored here --
      // but a future mark-read endpoint mustn't be able to race with this and pull lastReadSeq
      // backwards, and this stays correct even if that ever runs concurrently.
      await tx
        .update(memberships)
        .set({ lastReadSeq: sql`GREATEST(${memberships.lastReadSeq}, ${conv.seq})` })
        .where(
          and(
            eq(memberships.conversationId, input.conversationId),
            eq(memberships.userId, input.senderId),
          ),
        );
    }

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

export interface MessagesPage {
  /** Oldest first, ready to render top-to-bottom. */
  rows: MessageRow[];
  /** Whether requesting a page `before` the oldest row above would return anything. */
  hasMore: boolean;
}

/**
 * CHAT-016: a cursor-paged slice of a conversation's history, oldest first (ready to render
 * top-to-bottom). With `beforeSeq` omitted, returns the most recent `limit` messages; otherwise
 * the `limit` messages immediately before (lower `seq` than) `beforeSeq`.
 *
 * `hasMore` is computed by fetching one extra row past `limit` rather than comparing the page
 * length to `limit` -- the latter is wrong whenever the remaining history is an exact multiple
 * of the page size (it would report no more, when there's exactly one more page left).
 *
 * Deliberately no floor at the caller's `memberships.joinedAt`: a member currently sees the
 * conversation's *entire* history, including messages from before they joined. Harmless for
 * direct conversations (both members were there from the start), but this needs an explicit
 * decision -- not a silent carry-over -- once group conversations exist and someone can join one
 * partway through its history.
 */
export async function listMessagesPage(
  db: DbExecutor,
  conversationId: string,
  options: { beforeSeq?: number; limit: number },
): Promise<MessagesPage> {
  const conditions = [eq(messages.conversationId, conversationId)];
  if (options.beforeSeq !== undefined) conditions.push(lt(messages.seq, options.beforeSeq));

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  return { rows: rows.slice(0, options.limit).reverse(), hasMore };
}

/**
 * CHAT-017: gap sync -- everything the caller missed while disconnected, *ascending* (oldest of
 * the missed messages first, ready to append onto the end of what they already have), unlike
 * {@link listMessagesPage}'s newest-first history page. `hasMore` again comes from a limit+1
 * fetch, so a client that gets `hasMore: true` knows to call again with the new highest `seq` it
 * just received rather than assuming it's caught up.
 */
export async function listMessagesAfter(
  db: DbExecutor,
  conversationId: string,
  options: { afterSeq: number; limit: number },
): Promise<MessagesPage> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, options.afterSeq)))
    .orderBy(asc(messages.seq))
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  return { rows: rows.slice(0, options.limit), hasMore };
}

/** Stable key for a direct conversation between two users, order-independent. */
export function directKeyFor(userA: string, userB: string): string {
  if (userA === userB) throw new Error('A direct conversation needs two different users');
  return [userA, userB].sort().join(':');
}

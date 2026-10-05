import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { LinkPreview, MessageType } from '@videochat/shared';
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

/** Thrown by {@link appendMessage} when `(senderId, clientMsgId)` already names a message in a
 *  *different* conversation, or of a different type. The key has no conversation in it, so
 *  returning that row as an idempotent hit would re-broadcast it into the wrong conversation (and
 *  let a caller steer server-originated writes, e.g. call history, onto one of their own messages).
 *  A conflict, not a retry. */
export class ClientMsgIdConflictError extends Error {
  constructor(clientMsgId: string) {
    super(`clientMsgId ${clientMsgId} is already used by a different message`);
    this.name = 'ClientMsgIdConflictError';
  }
}

export interface AppendMessageResult {
  row: MessageRow;
  /** False when (senderId, clientMsgId) matched an existing message and nothing was inserted. */
  created: boolean;
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
 * duplicate. This is the foundation for CHAT-014's optimistic send and retry. A match in another
 * conversation (or of another type) throws {@link ClientMsgIdConflictError} instead.
 */
export async function appendMessage(db: Database, input: AppendMessageInput): Promise<MessageRow> {
  return (await appendMessageWithStatus(db, input)).row;
}

/** {@link appendMessage}, also saying whether a row was actually inserted. */
export async function appendMessageWithStatus(
  db: Database,
  input: AppendMessageInput,
): Promise<AppendMessageResult> {
  return db.transaction(async (tx) => {
    if (input.senderId && input.clientMsgId) {
      const existing = await findByClientMsgId(tx, input.senderId, input.clientMsgId);
      if (existing) {
        if (
          existing.conversationId !== input.conversationId ||
          existing.type !== (input.type ?? 'text')
        ) {
          throw new ClientMsgIdConflictError(input.clientMsgId);
        }
        return { row: existing, created: false };
      }
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

    return { row: row!, created: true };
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

/**
 * CHAT-031: sets (or, with null, removes) a message's link preview. Only while the message still
 * exists, isn't deleted, and still has the body the preview was made for -- an edit or delete
 * that landed while the preview was being fetched wins.
 */
export async function setMessageLinkPreview(
  db: DbExecutor,
  messageId: string,
  preview: LinkPreview | null,
  expectedBody?: string,
): Promise<MessageRow | undefined> {
  const conditions = [eq(messages.id, messageId), isNull(messages.deletedAt)];
  if (expectedBody !== undefined) conditions.push(eq(messages.body, expectedBody));
  const [row] = await db
    .update(messages)
    .set({
      meta: preview
        ? sql`coalesce(${messages.meta}, '{}'::jsonb) || jsonb_build_object('linkPreview', ${JSON.stringify(preview)}::jsonb)`
        : sql`case when ${messages.meta} is null then null else ${messages.meta} - 'linkPreview' end`,
    })
    .where(and(...conditions))
    .returning();
  return row;
}

export async function findMessage(
  db: DbExecutor,
  messageId: string,
): Promise<MessageRow | undefined> {
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return row;
}

/** CHAT-033: like {@link findMessage}, but takes a row lock (`FOR UPDATE`) for the rest of the
 *  caller's transaction -- serialises reactions on one message against each other (the
 *  distinct-emoji cap) and against a concurrent delete (whose UPDATE waits on the same lock). */
export async function lockMessage(
  db: DbExecutor,
  messageId: string,
): Promise<MessageRow | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
    .for('update');
  return row;
}

export async function findMessagesByIds(db: DbExecutor, ids: string[]): Promise<MessageRow[]> {
  if (!ids.length) return [];
  return db.select().from(messages).where(inArray(messages.id, ids));
}

/** CHAT-032: replaces a message's text. A link preview made for the old text is dropped (the
 *  caller re-fetches one for the new text). Nothing happens to a deleted message. */
export async function editMessageBody(
  db: DbExecutor,
  messageId: string,
  body: string,
): Promise<MessageRow | undefined> {
  const [row] = await db
    .update(messages)
    .set({
      body,
      editedAt: sql`now()`,
      meta: sql`case when ${messages.meta} is null then null else ${messages.meta} - 'linkPreview' end`,
    })
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .returning();
  return row;
}

/**
 * CHAT-032: "delete for everyone". The row stays as a tombstone (it holds a `seq`, and replies
 * point at it) but its content is really gone: body and meta (attachment summary, link preview)
 * are wiped, not just hidden.
 */
export async function softDeleteMessage(
  db: DbExecutor,
  messageId: string,
): Promise<MessageRow | undefined> {
  const [row] = await db
    .update(messages)
    .set({ deletedAt: sql`now()`, body: null, meta: null })
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .returning();
  return row;
}

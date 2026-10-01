import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database, DbExecutor } from './client.js';
import {
  conversations,
  memberships,
  messages,
  users,
  type Conversation,
  type Membership,
  type MessageRow,
} from './schema.js';
import { directKeyFor } from './messages.js';
import { isUniqueViolation } from './pg-errors.js';

export interface ConversationWithMembership extends Conversation {
  role: Membership['role'];
  lastReadSeq: Membership['lastReadSeq'];
}

/** True if `userId` is a current (not left) member of `conversationId`. Used to gate every
 *  conversation/message endpoint -- CHAT-022's "member-only access" authorisation check. */
export async function isConversationMember(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        eq(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Ids of every conversation `userId` currently belongs to. Used by the realtime gateway
 *  (CHAT-013) to snapshot, at connect time, which `conv:{id}` channels to fan messages in from. */
export async function listConversationIdsForUser(
  db: DbExecutor,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ conversationId: memberships.conversationId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), isNull(memberships.leftAt)));
  return rows.map((r) => r.conversationId);
}

/**
 * Finds the existing direct conversation between two users, or creates one. `directKey` is
 * unique-indexed (see schema.ts), so a race between two concurrent "start chat with X" requests
 * from either side can only ever produce one conversation: the loser's insert hits the unique
 * constraint, and we fall back to reading the winner's row.
 */
export async function findOrCreateDirectConversation(
  db: Database,
  userA: string,
  userB: string,
): Promise<ConversationWithMembership> {
  const directKey = directKeyFor(userA, userB);

  const existing = await findDirectConversationByKey(db, directKey, userA);
  if (existing) return existing;

  try {
    return await db.transaction(async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({ type: 'direct', directKey, createdBy: userA })
        .returning();
      await tx.insert(memberships).values([
        { conversationId: conv!.id, userId: userA },
        { conversationId: conv!.id, userId: userB },
      ]);
      return { ...conv!, role: 'member' as const, lastReadSeq: 0 };
    });
  } catch (err) {
    // Lost the race to create it: read back the row the other request just committed.
    if (isUniqueViolation(err)) {
      const raceWinner = await findDirectConversationByKey(db, directKey, userA);
      if (raceWinner) return raceWinner;
    }
    throw err;
  }
}

async function findDirectConversationByKey(
  db: DbExecutor,
  directKey: string,
  viewerId: string,
): Promise<ConversationWithMembership | undefined> {
  const [row] = await db
    .select({
      conversation: conversations,
      role: memberships.role,
      lastReadSeq: memberships.lastReadSeq,
    })
    .from(conversations)
    .innerJoin(
      memberships,
      and(eq(memberships.conversationId, conversations.id), eq(memberships.userId, viewerId)),
    )
    .where(eq(conversations.directKey, directKey))
    .limit(1);
  if (!row) return undefined;
  return { ...row.conversation, role: row.role, lastReadSeq: row.lastReadSeq };
}

export interface ConversationListRow extends ConversationWithMembership {
  /** The other member's user row, for a direct conversation (undefined for a group). */
  peer?: typeof users.$inferSelect;
  /** CHAT-019: the peer's own `lastReadSeq`, for a direct conversation (undefined for a group,
   *  same as `peer` -- see {@link loadDirectPeers}). */
  peerLastReadSeq?: number;
  /** CHAT-044: the newest message, for the inbox preview (undefined if there are none). */
  lastMessage?: MessageRow;
}

/** CHAT-044: each conversation's newest message, keyed by conversation id. One query for the
 *  whole list: `(conversation_id, seq)` is uniquely indexed and `last_seq` is the newest seq. */
async function loadLastMessages(
  db: DbExecutor,
  conversationIds: string[],
): Promise<Map<string, MessageRow>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(
      conversations,
      and(eq(conversations.id, messages.conversationId), eq(messages.seq, conversations.lastSeq)),
    )
    .where(inArray(conversations.id, conversationIds));
  return new Map(rows.map((r) => [r.message.conversationId, r.message]));
}

/** One conversation, as `userId` (a current member) sees it -- used by ChatPane (CHAT-014) to
 *  render a header without loading the whole list. Returns undefined for a non-member, same as
 *  a not-found, so a caller can 404 either way. */
export async function findConversationForUser(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<ConversationListRow | undefined> {
  const [row] = await db
    .select({
      conversation: conversations,
      role: memberships.role,
      lastReadSeq: memberships.lastReadSeq,
    })
    .from(memberships)
    .innerJoin(conversations, eq(conversations.id, memberships.conversationId))
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        eq(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  const peerEntry =
    row.conversation.type === 'direct'
      ? (await loadDirectPeers(db, [conversationId], userId)).get(conversationId)
      : undefined;
  const lastMessage = (await loadLastMessages(db, [conversationId])).get(conversationId);
  return {
    ...row.conversation,
    role: row.role,
    lastReadSeq: row.lastReadSeq,
    peer: peerEntry?.user,
    peerLastReadSeq: peerEntry?.lastReadSeq,
    lastMessage,
  };
}

/** Every conversation `userId` currently belongs to, newest activity first. For a direct
 *  conversation, also loads the other member so the client can show who it's with (a direct
 *  conversation has no title of its own). */
export async function listConversationsForUser(
  db: DbExecutor,
  userId: string,
): Promise<ConversationListRow[]> {
  const rows = await db
    .select({
      conversation: conversations,
      role: memberships.role,
      lastReadSeq: memberships.lastReadSeq,
    })
    .from(memberships)
    .innerJoin(conversations, eq(conversations.id, memberships.conversationId))
    .where(and(eq(memberships.userId, userId), isNull(memberships.leftAt)))
    .orderBy(desc(conversations.lastMessageAt));

  const direct = rows.filter((r) => r.conversation.type === 'direct');
  const peersByConversationId = await loadDirectPeers(
    db,
    direct.map((r) => r.conversation.id),
    userId,
  );

  const lastMessages = await loadLastMessages(
    db,
    rows.map((r) => r.conversation.id),
  );

  return rows.map((r) => {
    const peerEntry = peersByConversationId.get(r.conversation.id);
    return {
      ...r.conversation,
      role: r.role,
      lastReadSeq: r.lastReadSeq,
      peer: peerEntry?.user,
      peerLastReadSeq: peerEntry?.lastReadSeq,
      lastMessage: lastMessages.get(r.conversation.id),
    };
  });
}

/**
 * CHAT-018: creates a group conversation with `createdBy` as its sole admin and everyone else a
 * plain member, in one transaction -- so a crash between the two inserts can never leave a
 * "group" row with no memberships at all pointing at it.
 */
export async function createGroupConversation(
  db: Database,
  input: { title: string; createdBy: string; memberIds: string[] },
): Promise<ConversationWithMembership> {
  return db.transaction(async (tx) => {
    const [conv] = await tx
      .insert(conversations)
      .values({ type: 'group', title: input.title, createdBy: input.createdBy })
      .returning();
    await tx.insert(memberships).values([
      { conversationId: conv!.id, userId: input.createdBy, role: 'admin' },
      ...input.memberIds.map((userId) => ({
        conversationId: conv!.id,
        userId,
        role: 'member' as const,
      })),
    ]);
    return { ...conv!, role: 'admin' as const, lastReadSeq: 0 };
  });
}

/** The caller's own current (not left) membership row, or undefined if they aren't an active
 *  member -- used where the *role* is needed, not just the yes/no {@link isConversationMember}
 *  gives. */
export async function getMembership(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<Membership | undefined> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        eq(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .limit(1);
  return row;
}

/** How many active (not left) members a conversation currently has -- used to enforce
 *  `LIMITS.groupMaxMembers` when adding more. */
export async function countActiveMembers(db: DbExecutor, conversationId: string): Promise<number> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.conversationId, conversationId), isNull(memberships.leftAt)));
  return rows.length;
}

export async function renameConversation(
  db: DbExecutor,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set({ title })
    .where(eq(conversations.id, conversationId))
    .returning();
  if (!row) throw new Error(`Conversation ${conversationId} not found`);
  return row;
}

/**
 * CHAT-018: adds members to a group, skipping anyone who's already an active member (so a
 * double-submitted "add" is harmless rather than a constraint error). Someone who previously left
 * or was removed has a membership row already (the primary key is (conversationId, userId), and
 * `leftAt` just marks it inactive) -- re-adding them upserts that row back to active rather than
 * trying, and failing, to insert a second one for the same pair. They always rejoin as a plain
 * member, never with whatever role they had before leaving.
 *
 * Returns only the userIds that were actually (re)activated by this call, in input order, so the
 * caller can build a "X added Ben and Carl" system message that doesn't mention someone who was
 * already there.
 */
export async function addGroupMembers(
  db: Database,
  conversationId: string,
  userIds: string[],
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.conversationId, conversationId),
          inArray(memberships.userId, userIds),
          isNull(memberships.leftAt),
        ),
      );
    const alreadyActive = new Set(existing.map((e) => e.userId));
    const toAdd = userIds.filter((id) => !alreadyActive.has(id));
    if (toAdd.length === 0) return [];

    await tx
      .insert(memberships)
      .values(toAdd.map((userId) => ({ conversationId, userId, role: 'member' as const })))
      .onConflictDoUpdate({
        target: [memberships.conversationId, memberships.userId],
        set: { leftAt: null, role: 'member', joinedAt: sql`now()` },
      });
    return toAdd;
  });
}

/** Sets `leftAt` for one member (an admin removing someone, not the member removing themself --
 *  see {@link leaveConversation} for that, which also handles last-admin promotion). Returns
 *  false if they weren't an active member to begin with, so the caller can 404. */
export async function removeGroupMember(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .update(memberships)
    .set({ leftAt: sql`now()` })
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        eq(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .returning({ userId: memberships.userId });
  return row !== undefined;
}

export interface LeaveResult {
  /** Whether `userId` was actually an active member (false means "already left"/never a member,
   *  for the caller to turn into a 404). */
  left: boolean;
  /** The member promoted to admin as a result of this leave, or null if none was needed --
   *  either the leaver wasn't the last admin, or the group is now empty. */
  promotedUserId: string | null;
}

/**
 * CHAT-018: removes `userId` from the conversation and, if they were the *only* remaining admin,
 * promotes the oldest remaining member (by `joinedAt`) to admin -- all inside one transaction, so
 * a concurrent leave/remove can never observe (or produce) a group with active members but no
 * admin at all. "Oldest by `joinedAt`" matches the AC ("the oldest member is promoted") literally;
 * it says nothing about seniority otherwise (e.g. it's not "the next admin-eligible person" by any
 * other measure), so this is the simplest rule that satisfies it.
 */
export async function leaveConversation(
  db: Database,
  conversationId: string,
  userId: string,
): Promise<LeaveResult> {
  return db.transaction(async (tx) => {
    const [left] = await tx
      .update(memberships)
      .set({ leftAt: sql`now()` })
      .where(
        and(
          eq(memberships.conversationId, conversationId),
          eq(memberships.userId, userId),
          isNull(memberships.leftAt),
        ),
      )
      .returning();
    if (!left) return { left: false, promotedUserId: null };
    if (left.role !== 'admin') return { left: true, promotedUserId: null };

    const [remainingAdmin] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.conversationId, conversationId),
          eq(memberships.role, 'admin'),
          isNull(memberships.leftAt),
        ),
      )
      .limit(1);
    if (remainingAdmin) return { left: true, promotedUserId: null };

    const [oldest] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.conversationId, conversationId), isNull(memberships.leftAt)))
      .orderBy(asc(memberships.joinedAt))
      .limit(1);
    if (!oldest) return { left: true, promotedUserId: null }; // the group is now empty

    await tx
      .update(memberships)
      .set({ role: 'admin' })
      .where(
        and(eq(memberships.conversationId, conversationId), eq(memberships.userId, oldest.userId)),
      );
    return { left: true, promotedUserId: oldest.userId };
  });
}

export interface ActiveMemberRow {
  user: typeof users.$inferSelect;
  role: Membership['role'];
  joinedAt: Membership['joinedAt'];
  /** CHAT-019: this member's own `lastReadSeq` -- "Seen by N" is everyone here whose
   *  `lastReadSeq` is at least the conversation's `lastSeq`. */
  lastReadSeq: Membership['lastReadSeq'];
}

/** Every active member of a conversation, joined with their user row, oldest-joined first (which
 *  conveniently also matches "who'd be promoted next" if the current admin(s) left) -- CHAT-018's
 *  "members list shows roles" AC, extended by CHAT-019 with each member's `lastReadSeq` for
 *  "Seen by N". */
export async function listActiveMembers(
  db: DbExecutor,
  conversationId: string,
): Promise<ActiveMemberRow[]> {
  return db
    .select({
      user: users,
      role: memberships.role,
      joinedAt: memberships.joinedAt,
      lastReadSeq: memberships.lastReadSeq,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.conversationId, conversationId), isNull(memberships.leftAt)))
    .orderBy(asc(memberships.joinedAt));
}

/**
 * CHAT-019: advances the caller's own `lastReadSeq` for a conversation, never backward --
 * `GREATEST` mirrors the same guard `appendMessage` already uses for the sender's own bookkeeping
 * (see its comment for the race this protects against now that both paths can touch the same
 * row). Scoped to an *active* membership via the `WHERE` clause, so calling this after being
 * removed from the conversation returns `undefined` (the caller maps that to a 404) rather than
 * reviving a stale membership row.
 *
 * A single `UPDATE ... WHERE` is cheap enough that this needs no coalescing of its own on the
 * write side -- the "at most once per second per conversation" AC is enforced client-side (a
 * throttle keyed by conversation, see the web `ReadReceiptThrottle`), not something this function
 * needs to protect against a chatty caller for.
 */
export async function markConversationRead(
  db: DbExecutor,
  conversationId: string,
  userId: string,
  seq: number,
): Promise<Membership | undefined> {
  const [row] = await db
    .update(memberships)
    .set({ lastReadSeq: sql`GREATEST(${memberships.lastReadSeq}, ${seq})` })
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        eq(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .returning();
  return row;
}

/**
 * CHAT-019: "mark as unread" from the conversation menu. `target` is resolved by the caller
 * (`ConversationsService.markUnread`, as `lastSeq - 1`) rather than computed here, so this stays a
 * plain, easily-tested `UPDATE` -- see that method's own comment for why "one less than the
 * latest message" is the chosen semantics.
 *
 * `LEAST` guards the one direction that matters here: this must never *reduce* how much is
 * already unread. If the person hasn't opened the conversation in days, `lastReadSeq` may already
 * be well below `target`, and "mark as unread" re-flagging just the latest message would otherwise
 * silently forgive everything older than that.
 */
export async function markConversationUnread(
  db: DbExecutor,
  conversationId: string,
  userId: string,
  target: number,
): Promise<Membership | undefined> {
  const [row] = await db
    .update(memberships)
    .set({ lastReadSeq: sql`LEAST(${memberships.lastReadSeq}, ${target})` })
    .where(
      and(
        eq(memberships.conversationId, conversationId),
        eq(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .returning();
  return row;
}

interface DirectPeerEntry {
  user: typeof users.$inferSelect;
  /** CHAT-019: the peer's own `lastReadSeq` -- carried alongside their user row (rather than a
   *  separate query) since this join already sits on their membership row anyway. Powers a direct
   *  conversation's "Seen" indicator (`peerLastReadSeq >= lastSeq`). */
  lastReadSeq: number;
}

async function loadDirectPeers(
  db: DbExecutor,
  conversationIds: string[],
  excludeUserId: string,
): Promise<Map<string, DirectPeerEntry>> {
  const map = new Map<string, DirectPeerEntry>();
  if (conversationIds.length === 0) return map;

  // Direct conversations have exactly two members, so "the other member" is every membership
  // row on these conversations that isn't the viewer's own.
  const rows = await db
    .select({
      conversationId: memberships.conversationId,
      user: users,
      lastReadSeq: memberships.lastReadSeq,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        inArray(memberships.conversationId, conversationIds),
        ne(memberships.userId, excludeUserId),
      ),
    );
  for (const row of rows) {
    map.set(row.conversationId, { user: row.user, lastReadSeq: row.lastReadSeq });
  }
  return map;
}

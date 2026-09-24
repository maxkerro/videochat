import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Database, DbExecutor } from './client.js';
import { conversations, memberships, users, type Conversation, type Membership } from './schema.js';
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

  return rows.map((r) => ({
    ...r.conversation,
    role: r.role,
    lastReadSeq: r.lastReadSeq,
    peer: peersByConversationId.get(r.conversation.id),
  }));
}

async function loadDirectPeers(
  db: DbExecutor,
  conversationIds: string[],
  excludeUserId: string,
): Promise<Map<string, typeof users.$inferSelect>> {
  const map = new Map<string, typeof users.$inferSelect>();
  if (conversationIds.length === 0) return map;

  // Direct conversations have exactly two members, so "the other member" is every membership
  // row on these conversations that isn't the viewer's own.
  const rows = await db
    .select({ conversationId: memberships.conversationId, user: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        inArray(memberships.conversationId, conversationIds),
        ne(memberships.userId, excludeUserId),
      ),
    );
  for (const row of rows) {
    map.set(row.conversationId, row.user);
  }
  return map;
}

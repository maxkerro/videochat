import { and, eq, ne, or } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { blocks, conversations, memberships, users, type BlockRow } from './schema.js';

/**
 * CHAT-021: records that `blockerId` has blocked `blockedId`. Idempotent (`onConflictDoNothing`)
 * on the `(blockerId, blockedId)` primary key -- blocking someone already blocked is a silent
 * no-op rather than a 409, since from the blocker's point of view "block" is really "make sure
 * this person is blocked", not a one-shot event.
 */
export async function blockUser(
  db: DbExecutor,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db.insert(blocks).values({ blockerId, blockedId }).onConflictDoNothing();
}

/** CHAT-021: removes a block, if one exists. Also a no-op (not an error) when there wasn't one
 *  to remove -- unblocking someone who was never blocked lands you in the same place either way. */
export async function unblockUser(
  db: DbExecutor,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db
    .delete(blocks)
    .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)));
}

/** CHAT-021: true if `blockerId` has specifically blocked `blockedId` (this direction only) --
 *  the check `addMembers` and `messages.service.ts`'s `send()` use, where the AC cares about one
 *  particular direction (did *the target* block *the actor*), not just "is there a block between
 *  these two at all". Index-only lookup on the `(blockerId, blockedId)` primary key. */
export async function isBlocked(
  db: DbExecutor,
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
    .limit(1);
  return row !== undefined;
}

/** CHAT-021: true if either user has blocked the other -- the check `startDirect` uses ("blocked
 *  users cannot DM you" reads either way: neither side should be able to start it). Checked with
 *  a single `OR`ed query rather than two calls to {@link isBlocked}, so this stays one round trip. */
export async function hasBlockEitherDirection(
  db: DbExecutor,
  userA: string,
  userB: string,
): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, userA), eq(blocks.blockedId, userB)),
        and(eq(blocks.blockerId, userB), eq(blocks.blockedId, userA)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** CHAT-021: every user id in a block relationship with `userId`, either direction -- used by
 *  "find people" search (CHAT-012's "blocked users do not appear in search" AC) to exclude both
 *  people `userId` has blocked and people who have blocked `userId`, in one query. Returned as a
 *  `Set` since the caller only ever needs membership tests against it. */
export async function listBlockRelationshipUserIds(
  db: DbExecutor,
  userId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
    .from(blocks)
    .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.blockerId === userId ? row.blockedId : row.blockerId);
  }
  return ids;
}

export interface BlockedUserRow {
  user: typeof users.$inferSelect;
  createdAt: BlockRow['createdAt'];
}

/** CHAT-021: everyone `userId` has blocked, most recently blocked first -- backs the blocklist
 *  view ("view/manage a blocklist" from the story brief). */
export async function listBlockedUsers(db: DbExecutor, userId: string): Promise<BlockedUserRow[]> {
  const rows = await db
    .select({ user: users, createdAt: blocks.createdAt })
    .from(blocks)
    .innerJoin(users, eq(users.id, blocks.blockedId))
    .where(eq(blocks.blockerId, userId))
    .orderBy(blocks.createdAt);
  return rows.reverse();
}

/**
 * CHAT-021: true only for a *direct* conversation whose other member has blocked `senderId` --
 * the check `MessagesService.send` uses to reject a blocked sender's DM. A single query joining
 * `conversations` (must be `type = 'direct'`) to the *other* membership row (`userId <>
 * senderId` -- a direct conversation has exactly one other member) to `blocks` (that other member
 * as blocker, `senderId` as blocked), so this is one round trip rather than three. Always false
 * for a group conversation -- see `MessagesService.send`'s own comment on why block enforcement
 * is DM-only for this story.
 */
export async function isSenderBlockedInDirectConversation(
  db: DbExecutor,
  conversationId: string,
  senderId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: blocks.blockerId })
    .from(conversations)
    .innerJoin(
      memberships,
      and(eq(memberships.conversationId, conversations.id), ne(memberships.userId, senderId)),
    )
    .innerJoin(
      blocks,
      and(eq(blocks.blockerId, memberships.userId), eq(blocks.blockedId, senderId)),
    )
    .where(and(eq(conversations.id, conversationId), eq(conversations.type, 'direct')))
    .limit(1);
  return row !== undefined;
}

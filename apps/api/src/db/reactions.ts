import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Reaction } from '@videochat/shared';
import type { DbExecutor } from './client.js';
import { reactions } from './schema.js';

/** CHAT-033: reactions on these messages, grouped by message, then emoji (first-used order). */
export async function listReactions(
  db: DbExecutor,
  messageIds: string[],
): Promise<Map<string, Reaction[]>> {
  const byMessage = new Map<string, Reaction[]>();
  if (!messageIds.length) return byMessage;
  const rows = await db
    .select()
    .from(reactions)
    .where(inArray(reactions.messageId, messageIds))
    .orderBy(asc(reactions.createdAt), asc(reactions.userId));
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    let group = list.find((r) => r.emoji === row.emoji);
    if (!group) {
      group = { emoji: row.emoji, count: 0, userIds: [] };
      list.push(group);
    }
    group.count += 1;
    group.userIds.push(row.userId);
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

/**
 * Adds the reaction, or removes it if this person already reacted with this emoji. Returns
 * whether it's now on. Refuses a new emoji once the message has `maxDistinct` different ones.
 */
export async function toggleReaction(
  db: DbExecutor,
  messageId: string,
  userId: string,
  emoji: string,
  maxDistinct: number,
): Promise<'added' | 'removed' | 'limit'> {
  const removed = await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.messageId, messageId),
        eq(reactions.userId, userId),
        eq(reactions.emoji, emoji),
      ),
    )
    .returning({ emoji: reactions.emoji });
  if (removed.length) return 'removed';

  const [existing] = await db
    .select({ n: count(sql`distinct ${reactions.emoji}`) })
    .from(reactions)
    .where(eq(reactions.messageId, messageId));
  const alreadyUsed = await db
    .select({ emoji: reactions.emoji })
    .from(reactions)
    .where(and(eq(reactions.messageId, messageId), eq(reactions.emoji, emoji)))
    .limit(1);
  if (!alreadyUsed.length && (existing?.n ?? 0) >= maxDistinct) return 'limit';

  await db.insert(reactions).values({ messageId, userId, emoji }).onConflictDoNothing();
  return 'added';
}

export async function deleteReactionsForMessage(db: DbExecutor, messageId: string): Promise<void> {
  await db.delete(reactions).where(eq(reactions.messageId, messageId));
}

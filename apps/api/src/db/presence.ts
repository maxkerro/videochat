import type { LastSeenVisibility } from '@videochat/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { users } from './schema.js';

/** CHAT-034: someone who shares at least one conversation with `userId`, as presence needs it. */
export interface PresenceContact {
  userId: string;
  /** Their own last-seen setting. */
  visibility: LastSeenVisibility;
  /** Whether they and `userId` have a direct conversation (the "contacts" visibility level). */
  sharesDirect: boolean;
}

/** Everyone `userId` currently shares a conversation with (optionally only `among` these). */
export async function listPresenceContacts(
  db: DbExecutor,
  userId: string,
  among?: string[],
): Promise<PresenceContact[]> {
  if (among && among.length === 0) return [];
  const filter = among
    ? sql`and other.user_id in (${sql.join(
        among.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const result = await db.execute<{
    user_id: string;
    visibility: LastSeenVisibility;
    shares_direct: boolean;
  }>(sql`
    select other.user_id, u.last_seen_visibility as visibility,
           bool_or(c.type = 'direct') as shares_direct
    from memberships me
    join memberships other
      on other.conversation_id = me.conversation_id
     and other.user_id <> me.user_id
     and other.left_at is null
    join conversations c on c.id = me.conversation_id
    join users u on u.id = other.user_id
    where me.user_id = ${userId} and me.left_at is null ${filter}
    group by other.user_id, u.last_seen_visibility
  `);
  return result.rows.map((r) => ({
    userId: r.user_id,
    visibility: r.visibility,
    sharesDirect: r.shares_direct,
  }));
}

export async function getPresenceSettings(
  db: DbExecutor,
  userIds: string[],
): Promise<Map<string, { visibility: LastSeenVisibility; lastActiveAt: Date | null }>> {
  const map = new Map<string, { visibility: LastSeenVisibility; lastActiveAt: Date | null }>();
  if (!userIds.length) return map;
  const rows = await db
    .select({
      id: users.id,
      visibility: users.lastSeenVisibility,
      lastActiveAt: users.lastActiveAt,
    })
    .from(users)
    .where(
      sql`${users.id} in (${sql.join(
        userIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  for (const r of rows) map.set(r.id, { visibility: r.visibility, lastActiveAt: r.lastActiveAt });
  return map;
}

export async function setLastActive(db: DbExecutor, userId: string, at: Date): Promise<void> {
  await db.update(users).set({ lastActiveAt: at }).where(eq(users.id, userId));
}

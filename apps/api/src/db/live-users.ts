import { and, inArray, isNull } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { users } from './schema.js';

/** One of the people a membership was about to be created for is gone (deleted account). */
export class UserUnavailableError extends Error {
  constructor() {
    super('User not found');
    this.name = 'UserUnavailableError';
  }
}

/**
 * CHAT-037 review: inside a transaction that creates memberships, takes a share lock on each
 * person's row and checks none is deleted. Account deletion holds the row's exclusive lock for
 * its whole transaction, so the two serialise: a membership can't slip in while the account is
 * being erased (Postgres re-checks `deleted_at` on the row it waited for).
 */
export async function lockLiveUsers(db: DbExecutor, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.deletedAt)))
    .for('share');
  if (rows.length !== ids.length) throw new UserUnavailableError();
}

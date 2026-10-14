import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { groupCalls, type GroupCallRow } from './schema.js';

/*
 * CHAT-070 data access. Like 1:1 calls, every transition is one conditional statement, so two
 * people starting a call at once, or two API nodes sweeping at once, have exactly one winner.
 */

export async function findRunningGroupCall(
  db: DbExecutor,
  conversationId: string,
): Promise<GroupCallRow | undefined> {
  const [row] = await db
    .select()
    .from(groupCalls)
    .where(and(eq(groupCalls.conversationId, conversationId), isNull(groupCalls.endedAt)))
    .limit(1);
  return row;
}

export async function getGroupCall(db: DbExecutor, id: string): Promise<GroupCallRow | undefined> {
  const [row] = await db.select().from(groupCalls).where(eq(groupCalls.id, id)).limit(1);
  return row;
}

/** Starts a call in `conversationId`, or returns the one already running there. `created` says
 *  which (only the creator announces it). */
export async function startOrGetGroupCall(
  db: DbExecutor,
  conversationId: string,
  startedBy: string,
): Promise<{ call: GroupCallRow; created: boolean }> {
  const [created] = await db
    .insert(groupCalls)
    .values({ conversationId, startedBy })
    .onConflictDoNothing()
    .returning();
  if (created) return { call: created, created: true };
  const running = await findRunningGroupCall(db, conversationId);
  if (running) return { call: running, created: false };
  // The running call ended between the two statements: try once more.
  return startOrGetGroupCall(db, conversationId, startedBy);
}

export async function listRunningGroupCalls(db: DbExecutor): Promise<GroupCallRow[]> {
  return db.select().from(groupCalls).where(isNull(groupCalls.endedAt));
}

/** Records the SFU's participant count. Returns the row only if the count changed. */
export async function setGroupCallParticipants(
  db: DbExecutor,
  id: string,
  count: number,
): Promise<GroupCallRow | undefined> {
  const [row] = await db
    .update(groupCalls)
    .set({
      participantCount: count,
      peakParticipants: sql`greatest(${groupCalls.peakParticipants}, ${count})`,
    })
    .where(
      and(
        eq(groupCalls.id, id),
        isNull(groupCalls.endedAt),
        sql`${groupCalls.participantCount} <> ${count}`,
      ),
    )
    .returning();
  return row;
}

/** Ends running calls among `ids`. Returns the ones this call ended. */
export async function endGroupCalls(
  db: DbExecutor,
  ids: string[],
  now: Date = new Date(),
): Promise<GroupCallRow[]> {
  if (ids.length === 0) return [];
  return db
    .update(groupCalls)
    .set({ endedAt: now, participantCount: 0 })
    .where(and(inArray(groupCalls.id, ids), isNull(groupCalls.endedAt)))
    .returning();
}

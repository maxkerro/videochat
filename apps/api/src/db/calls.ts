import type { CallEndReason, CallStatus } from '@videochat/shared';
import { and, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbExecutor } from './client.js';
import { calls, conversations, memberships, users, type CallRow, type User } from './schema.js';

/*
 * CHAT-041 data access. Every state change is a single conditional UPDATE ... RETURNING: the row
 * comes back only if this caller won the transition, so concurrent answers, a hang-up racing the
 * ring timeout, or two API nodes sweeping at once can't both "win". Callers notify the
 * participants only when they get a row back.
 */

export type NewCall = Pick<
  CallRow,
  'id' | 'conversationId' | 'callerId' | 'calleeId' | 'media' | 'callerConnectionId' | 'silenced'
>;

/** Inserts a new ringing call. Returns undefined if the id is already taken (a retried invite). */
export async function insertCall(db: DbExecutor, call: NewCall): Promise<CallRow | undefined> {
  const [row] = await db.insert(calls).values(call).onConflictDoNothing().returning();
  return row;
}

export async function getCall(db: DbExecutor, id: string): Promise<CallRow | undefined> {
  const [row] = await db.select().from(calls).where(eq(calls.id, id)).limit(1);
  return row;
}

/** A call `userId` is currently part of (ringing or active, either side), if any. */
export async function findOpenCallForUser(
  db: DbExecutor,
  userId: string,
): Promise<CallRow | undefined> {
  const [row] = await db
    .select()
    .from(calls)
    .where(
      and(ne(calls.status, 'ended'), or(eq(calls.callerId, userId), eq(calls.calleeId, userId))),
    )
    .limit(1);
  return row;
}

/** ringing -> active, claimed by the callee device that answered. Undefined if it wasn't ringing
 *  any more (answered on another device, cancelled, timed out). */
export async function acceptCall(
  db: DbExecutor,
  id: string,
  calleeId: string,
  calleeConnectionId: string,
  now: Date = new Date(),
): Promise<CallRow | undefined> {
  const [row] = await db
    .update(calls)
    .set({ status: 'active', calleeConnectionId, answeredAt: now })
    .where(
      and(
        eq(calls.id, id),
        eq(calls.calleeId, calleeId),
        eq(calls.status, 'ringing'),
        eq(calls.silenced, false),
      ),
    )
    .returning();
  return row;
}

/** Ends a call that is currently in one of `from`. Undefined if it was already over. */
export async function endCall(
  db: DbExecutor,
  id: string,
  reason: CallEndReason,
  from: readonly CallStatus[],
  now: Date = new Date(),
): Promise<CallRow | undefined> {
  const [row] = await db
    .update(calls)
    .set({ status: 'ended', endReason: reason, endedAt: now })
    .where(and(eq(calls.id, id), inArray(calls.status, [...from])))
    .returning();
  return row;
}

/**
 * A socket closed. A caller's still-ringing call is cancelled outright (there's nobody left to
 * hear it connect); an active call on that socket is only *marked* -- the participant may be
 * reconnecting (CHAT-043) and gets the grace period to `resume` before the sweep ends it.
 */
export async function handleConnectionGone(
  db: DbExecutor,
  connectionId: string,
  now: Date = new Date(),
): Promise<{ cancelled: CallRow[] }> {
  const cancelled = await db
    .update(calls)
    .set({ status: 'ended', endReason: 'cancelled', endedAt: now })
    .where(and(eq(calls.callerConnectionId, connectionId), eq(calls.status, 'ringing')))
    .returning();
  await db
    .update(calls)
    .set({ callerDisconnectedAt: now })
    .where(and(eq(calls.callerConnectionId, connectionId), eq(calls.status, 'active')));
  await db
    .update(calls)
    .set({ calleeDisconnectedAt: now })
    .where(and(eq(calls.calleeConnectionId, connectionId), eq(calls.status, 'active')));
  return { cancelled };
}

/** Re-attaches a participant's new socket to their active call. Undefined if `userId` isn't in
 *  this call or it's no longer active. */
export async function resumeCall(
  db: DbExecutor,
  id: string,
  userId: string,
  connectionId: string,
): Promise<CallRow | undefined> {
  const [asCaller] = await db
    .update(calls)
    .set({ callerConnectionId: connectionId, callerDisconnectedAt: null })
    .where(and(eq(calls.id, id), eq(calls.callerId, userId), eq(calls.status, 'active')))
    .returning();
  if (asCaller) return asCaller;
  const [asCallee] = await db
    .update(calls)
    .set({ calleeConnectionId: connectionId, calleeDisconnectedAt: null })
    .where(and(eq(calls.id, id), eq(calls.calleeId, userId), eq(calls.status, 'active')))
    .returning();
  return asCallee;
}

/** Ends every call whose time is up: unanswered past the ring timeout (`missed`), or with a
 *  participant gone past the reconnect grace period (`connection-lost`). */
export async function endExpiredCalls(
  db: DbExecutor,
  now: Date,
  ringTimeoutSec: number,
  reconnectGraceSec: number,
): Promise<CallRow[]> {
  const ringCutoff = new Date(now.getTime() - ringTimeoutSec * 1000);
  const graceCutoff = new Date(now.getTime() - reconnectGraceSec * 1000);
  const missed = await db
    .update(calls)
    .set({ status: 'ended', endReason: 'missed', endedAt: now })
    .where(and(eq(calls.status, 'ringing'), lt(calls.createdAt, ringCutoff)))
    .returning();
  const lost = await db
    .update(calls)
    .set({ status: 'ended', endReason: 'connection-lost', endedAt: now })
    .where(
      and(
        eq(calls.status, 'active'),
        or(
          lt(calls.callerDisconnectedAt, graceCutoff),
          lt(calls.calleeDisconnectedAt, graceCutoff),
        ),
      ),
    )
    .returning();
  return [...missed, ...lost];
}

/** The connection on the *other* side of the call from `connectionId`, if `connectionId` is one
 *  of the two in an active call. Used to relay offer/answer/ICE/media only between the two
 *  devices actually in the call. */
export function peerConnectionOf(call: CallRow, connectionId: string): string | undefined {
  if (call.status !== 'active') return undefined;
  if (call.callerConnectionId === connectionId) return call.calleeConnectionId ?? undefined;
  if (call.calleeConnectionId === connectionId) return call.callerConnectionId;
  return undefined;
}

/**
 * The other member of a direct conversation, if `userId` is a current member of it and it is a
 * direct conversation with a current second member. Calls are 1:1 only (CHAT-041), so a group,
 * a conversation the caller left, or one they were never in all come back undefined.
 */
export async function findDirectPeer(
  db: DbExecutor,
  conversationId: string,
  userId: string,
): Promise<User | undefined> {
  const self = alias(memberships, 'self');
  const [row] = await db
    .select({ peer: users })
    .from(conversations)
    .innerJoin(
      self,
      and(eq(self.conversationId, conversations.id), eq(self.userId, userId), isNull(self.leftAt)),
    )
    .innerJoin(
      memberships,
      and(
        eq(memberships.conversationId, conversations.id),
        ne(memberships.userId, userId),
        isNull(memberships.leftAt),
      ),
    )
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.type, 'direct')))
    .limit(1);
  return row?.peer;
}

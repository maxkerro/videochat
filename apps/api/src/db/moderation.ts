import type { ModerationUser, ReportStatus } from '@videochat/shared';
import { MODERATION } from '@videochat/shared';
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import {
  messageReports,
  messages,
  moderationActions,
  users,
  type MessageReportRow,
  type MessageRow,
  type ModerationActionRow,
  type User,
} from './schema.js';

/** CHAT-077: the moderation queue, restrictions and the audit log. */

export async function isModerator(db: DbExecutor, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ m: users.isModerator })
    .from(users)
    .where(and(eq(users.id, userId), sql`${users.deletedAt} IS NULL`))
    .limit(1);
  return row?.m === true;
}

export async function setModerator(db: DbExecutor, email: string, on: boolean): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ isModerator: on })
    .where(sql`lower(${users.email}) = lower(${email}) AND ${users.deletedAt} IS NULL`)
    .returning({ id: users.id });
  return rows.length > 0;
}

export function toModerationUser(
  u: Pick<User, 'id' | 'username' | 'displayName' | 'deletedAt' | 'suspendedUntil' | 'bannedAt'>,
): ModerationUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    deleted: u.deletedAt !== null,
    suspendedUntil: u.suspendedUntil ? u.suspendedUntil.toISOString() : null,
    bannedAt: u.bannedAt ? u.bannedAt.toISOString() : null,
  };
}

export async function findUsersByIds(
  db: DbExecutor,
  ids: (string | null)[],
): Promise<Map<string, User>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u]));
}

/** `createdAt|id` of a row, for keyset paging (newest first). */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split('|');
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at: date, id };
}

/** Open reports are worked oldest first (a queue); closed ones are browsed newest first. */
export async function listReports(
  db: DbExecutor,
  status: ReportStatus,
  cursor: string | undefined,
): Promise<{ rows: MessageReportRow[]; hasMore: boolean }> {
  const after = decodeCursor(cursor);
  const oldestFirst = status === 'open';
  const keyset = after
    ? oldestFirst
      ? or(
          gt(messageReports.createdAt, after.at),
          and(eq(messageReports.createdAt, after.at), gt(messageReports.id, after.id)),
        )
      : or(
          lt(messageReports.createdAt, after.at),
          and(eq(messageReports.createdAt, after.at), lt(messageReports.id, after.id)),
        )
    : undefined;
  const rows = await db
    .select()
    .from(messageReports)
    .where(and(eq(messageReports.status, status), keyset))
    .orderBy(
      ...(oldestFirst
        ? [asc(messageReports.createdAt), asc(messageReports.id)]
        : [desc(messageReports.createdAt), desc(messageReports.id)]),
    )
    .limit(MODERATION.pageSize + 1);
  return { rows: rows.slice(0, MODERATION.pageSize), hasMore: rows.length > MODERATION.pageSize };
}

/** Open reports per reported person. */
export async function countOpenReportsAbout(
  db: DbExecutor,
  userIds: (string | null)[],
): Promise<Map<string, number>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ userId: messageReports.reportedUserId, n: sql<number>`count(*)::int` })
    .from(messageReports)
    .where(and(eq(messageReports.status, 'open'), inArray(messageReports.reportedUserId, ids)))
    .groupBy(messageReports.reportedUserId);
  return new Map(rows.map((r) => [r.userId!, r.n]));
}

export async function findReport(
  db: DbExecutor,
  id: string,
): Promise<MessageReportRow | undefined> {
  const [row] = await db.select().from(messageReports).where(eq(messageReports.id, id)).limit(1);
  return row;
}

/**
 * The reported message and the `MODERATION.contextMessages` messages nearest to it in the same
 * conversation, alternating before/after (so a message at the very start of a chat gets its
 * context from after it). Nothing further away is ever loaded.
 */
export async function loadReportContext(
  db: DbExecutor,
  conversationId: string,
  seq: number,
): Promise<MessageRow[]> {
  const n = MODERATION.contextMessages;
  const [before, at, after] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), lt(messages.seq, seq)))
      .orderBy(desc(messages.seq))
      .limit(n),
    db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.seq, seq)))
      .limit(1),
    db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, seq)))
      .orderBy(asc(messages.seq))
      .limit(n),
  ]);
  const picked: MessageRow[] = [];
  let b = 0;
  let a = 0;
  while (picked.length < n && (b < before.length || a < after.length)) {
    if (b < before.length && (b <= a || a >= after.length)) picked.push(before[b++]!);
    else picked.push(after[a++]!);
  }
  return [...picked, ...at].sort((x, y) => x.seq - y.seq);
}

/** Closes an open report. Undefined when it was already closed (by someone else, say). */
export async function closeReport(
  db: DbExecutor,
  id: string,
  input: { moderatorId: string; action: string; note: string | null },
): Promise<MessageReportRow | undefined> {
  const [row] = await db
    .update(messageReports)
    .set({
      status: input.action === 'dismiss' ? 'dismissed' : 'resolved',
      resolvedAt: sql`now()`,
      resolvedBy: input.moderatorId,
      resolution: input.action,
      resolutionNote: input.note,
    })
    .where(and(eq(messageReports.id, id), eq(messageReports.status, 'open')))
    .returning();
  return row;
}

export async function restrictUser(
  db: DbExecutor,
  userId: string,
  restriction: { suspendedUntil: Date } | { banned: true } | { lift: true },
): Promise<void> {
  await db
    .update(users)
    .set(
      'lift' in restriction
        ? { suspendedUntil: null, bannedAt: null }
        : 'banned' in restriction
          ? { bannedAt: sql`now()` }
          : { suspendedUntil: restriction.suspendedUntil },
    )
    .where(eq(users.id, userId));
}

export async function insertAudit(
  db: DbExecutor,
  entry: {
    moderatorId: string;
    action: string;
    reportId?: string | null;
    targetUserId?: string | null;
    note?: string | null;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(moderationActions).values({
    moderatorId: entry.moderatorId,
    action: entry.action,
    reportId: entry.reportId ?? null,
    targetUserId: entry.targetUserId ?? null,
    note: entry.note ?? null,
    details: entry.details ?? null,
  });
}

export async function listAudit(
  db: DbExecutor,
  cursor: string | undefined,
  targetUserId: string | undefined,
): Promise<{ rows: ModerationActionRow[]; hasMore: boolean }> {
  const after = decodeCursor(cursor);
  const rows = await db
    .select()
    .from(moderationActions)
    .where(
      and(
        targetUserId ? eq(moderationActions.targetUserId, targetUserId) : undefined,
        after
          ? or(
              lt(moderationActions.createdAt, after.at),
              and(eq(moderationActions.createdAt, after.at), lt(moderationActions.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
    .limit(MODERATION.pageSize + 1);
  return { rows: rows.slice(0, MODERATION.pageSize), hasMore: rows.length > MODERATION.pageSize };
}

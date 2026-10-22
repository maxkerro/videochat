import { sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { messageReports } from './schema.js';

/** CHAT-058: records a report. Reporting the same message again updates the earlier report rather
 *  than adding another, so a double tap (or a retry) is harmless. */
export async function upsertMessageReport(
  db: DbExecutor,
  input: {
    reporterId: string;
    reportedUserId: string | null;
    conversationId: string;
    messageId: string;
    reason: string;
    details: string | null;
    bodySnapshot: string | null;
    snapshotFromReporter?: boolean;
  },
): Promise<void> {
  await db
    .insert(messageReports)
    .values(input)
    .onConflictDoUpdate({
      target: [messageReports.reporterId, messageReports.messageId],
      // CHAT-077: reporting it again puts it back in the queue.
      set: {
        reason: input.reason,
        details: input.details,
        createdAt: sql`now()`,
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
        resolutionNote: null,
      },
    });
}

/** CHAT-077: a report of a person (no message). One open report per reporter and person:
 *  reporting them again while it's open just updates it. */
export async function upsertUserReport(
  db: DbExecutor,
  input: {
    reporterId: string;
    reportedUserId: string;
    conversationId: string;
    reason: string;
    details: string | null;
  },
): Promise<void> {
  await db
    .insert(messageReports)
    .values({ ...input, messageId: null, bodySnapshot: null })
    .onConflictDoUpdate({
      target: [messageReports.reporterId, messageReports.reportedUserId],
      targetWhere: sql`${messageReports.messageId} IS NULL AND ${messageReports.status} = 'open'`,
      set: {
        reason: input.reason,
        details: input.details,
        conversationId: input.conversationId,
        createdAt: sql`now()`,
      },
    });
}

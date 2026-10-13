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
  },
): Promise<void> {
  await db
    .insert(messageReports)
    .values(input)
    .onConflictDoUpdate({
      target: [messageReports.reporterId, messageReports.messageId],
      set: { reason: input.reason, details: input.details, createdAt: sql`now()` },
    });
}

import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { attachments, type AttachmentRow } from './schema.js';

/** CHAT-030: the attachment repository. Authorisation lives in AttachmentsService. */
export async function insertAttachment(
  db: DbExecutor,
  row: typeof attachments.$inferInsert,
): Promise<AttachmentRow> {
  const [created] = await db.insert(attachments).values(row).returning();
  return created!;
}

export async function findAttachment(
  db: DbExecutor,
  id: string,
): Promise<AttachmentRow | undefined> {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return row;
}

export async function markAttachmentProcessed(
  db: DbExecutor,
  id: string,
  fields: Pick<AttachmentRow, 'sizeBytes' | 'width' | 'height' | 'thumbKey' | 'contentType'> &
    Partial<Pick<AttachmentRow, 'kind'>>,
): Promise<AttachmentRow> {
  const [row] = await db
    .update(attachments)
    .set({ ...fields, processedAt: sql`now()` })
    .where(eq(attachments.id, id))
    .returning();
  return row!;
}

/** Links a processed attachment to the message that carries it. Only the first message wins,
 *  and a row the unsent-sweep already deleted links nothing (both report false). Runs inside the
 *  message-insert transaction (`appendMessageWithStatus`). */
export async function linkAttachmentToMessage(
  db: DbExecutor,
  id: string,
  messageId: string,
): Promise<boolean> {
  const rows = await db
    .update(attachments)
    .set({ messageId })
    .where(
      and(
        eq(attachments.id, id),
        isNull(attachments.messageId),
        isNotNull(attachments.processedAt),
      ),
    )
    .returning({ id: attachments.id });
  return rows.length > 0;
}

export async function findAttachmentsForMessage(
  db: DbExecutor,
  messageId: string,
): Promise<AttachmentRow[]> {
  return db.select().from(attachments).where(eq(attachments.messageId, messageId));
}

/** Deletes up to `limit` never-sent attachments created before `cutoff`, returning them so
 *  their objects can be removed too. The conditions are repeated on the outer DELETE so that
 *  Postgres re-checks them against a row a concurrent send just linked (and skips it), rather
 *  than trusting the subquery's older snapshot. */
export async function deleteStaleUnsentAttachments(
  db: DbExecutor,
  cutoff: Date,
  limit = 100,
): Promise<AttachmentRow[]> {
  return db
    .delete(attachments)
    .where(
      and(
        isNull(attachments.messageId),
        lt(attachments.createdAt, cutoff),
        sql`${attachments.id} in (select ${attachments.id} from ${attachments}
          where ${attachments.messageId} is null and ${attachments.createdAt} < ${cutoff}
          limit ${limit})`,
      ),
    )
    .returning();
}

export async function deleteAttachments(db: DbExecutor, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.delete(attachments).where(inArray(attachments.id, ids));
}

import { DELETED_USERNAME_PREFIX, type UpdateSettingsInput } from '@videochat/shared';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DbExecutor } from './client.js';
import {
  attachments,
  authTokens,
  blocks,
  conversations,
  devices,
  memberships,
  messages,
  reactions,
  refreshTokens,
  users,
  type AttachmentRow,
  type User,
  type MessageRow,
} from './schema.js';

/** CHAT-037: applies a partial settings change. */
export async function updateUserSettings(
  db: DbExecutor,
  userId: string,
  input: UpdateSettingsInput,
): Promise<User> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (input.readReceipts !== undefined) set.readReceipts = input.readReceipts;
  if (input.lastSeenVisibility !== undefined) set.lastSeenVisibility = input.lastSeenVisibility;
  if (input.theme !== undefined) set.theme = input.theme;
  if (input.notifications?.enabled !== undefined) set.notifyEnabled = input.notifications.enabled;
  if (input.notifications?.sound !== undefined) set.notifySound = input.notifications.sound;
  if (input.notifications?.previews !== undefined) {
    set.notifyPreviews = input.notifications.previews;
  }
  const [row] = Object.keys(set).length
    ? await db.update(users).set(set).where(eq(users.id, userId)).returning()
    : await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error(`User ${userId} not found`);
  return row;
}

/** Active memberships, for leaving everything when the account is deleted. */
export async function listActiveConversationIds(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: memberships.conversationId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), isNull(memberships.leftAt)));
  return rows.map((r) => r.id);
}

/**
 * CHAT-037: erases a deleted account's personal data, leaving an anonymous husk so that
 * conversations, message order and other people's replies stay intact:
 * - every message they sent becomes a "Message deleted" tombstone (text, attachments, previews
 *   gone); their reactions, devices, sessions, blocks and pending tokens are removed;
 * - the user row keeps only its id: email/username/name replaced, avatar and password cleared.
 * Returns the attachment rows whose stored files the caller must delete.
 */
export async function eraseAccount(
  db: DbExecutor,
  userId: string,
): Promise<{ files: AttachmentRow[]; erased: MessageRow[] }> {
  // Only what they wrote or shared. Call entries are other people's record too (and carry no
  // content of theirs), so they stay.
  const erased = await db
    .update(messages)
    .set({ body: null, meta: null, deletedAt: sql`now()` })
    .where(
      and(
        eq(messages.senderId, userId),
        isNull(messages.deletedAt),
        inArray(messages.type, ['text', 'image', 'file']),
      ),
    )
    .returning();
  const files = await db.delete(attachments).where(eq(attachments.uploaderId, userId)).returning();
  await db.delete(reactions).where(eq(reactions.userId, userId));
  await db.delete(devices).where(eq(devices.userId, userId));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  await db.delete(authTokens).where(eq(authTokens.userId, userId));
  await db.delete(blocks).where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
  // `deleted_` is a prefix nobody can choose (see chosenUsernameSchema), so this can't collide
  // with a name someone registered ahead of time; 22 hex chars of the id keep two deleted
  // accounts apart and fit the 30-character limit.
  const shortId = userId.replace(/-/g, '').slice(0, 30 - DELETED_USERNAME_PREFIX.length);
  // Accounts made before the prefix was reserved could hold this exact name already: fall back
  // to a random one rather than failing the whole deletion.
  let username = `${DELETED_USERNAME_PREFIX}${shortId}`;
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.username}) = ${username}`, ne(users.id, userId)))
    .limit(1);
  if (taken) {
    username = `${DELETED_USERNAME_PREFIX}${randomBytes(11).toString('hex')}`;
  }
  await db
    .update(users)
    .set({
      email: `deleted+${userId}@deleted.invalid`,
      username,
      displayName: 'Deleted user',
      avatarKey: null,
      passwordHash: null,
      emailVerifiedAt: null,
      lastActiveAt: null,
      lastSeenVisibility: 'nobody',
      readReceipts: false,
      notifyEnabled: false,
      deletedAt: sql`now()`,
    })
    .where(eq(users.id, userId));
  return { files, erased };
}

export interface ExportedMessage {
  conversationId: string;
  id: string;
  seq: number;
  type: string;
  body: string | null;
  attachment: string | null;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
}

/** CHAT-037 data export: every message this person sent that still exists, oldest first. */
export async function listMessagesSentBy(
  db: DbExecutor,
  userId: string,
): Promise<ExportedMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.senderId, userId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => ({
    conversationId: r.conversationId,
    id: r.id,
    seq: r.seq,
    type: r.type,
    body: r.body,
    attachment: r.meta?.attachment?.filename ?? null,
    replyToId: r.replyToId,
    createdAt: r.createdAt,
    editedAt: r.editedAt,
  }));
}

/** CHAT-037 data export: the conversations they're in, with who else is in them. */
export async function listConversationsForExport(db: DbExecutor, userId: string) {
  const result = await db.execute<{
    id: string;
    type: string;
    title: string | null;
    joined_at: Date;
    left_at: Date | null;
    members: string[];
  }>(sql`
    select c.id, c.type, c.title, me.joined_at, me.left_at,
           coalesce(array_agg(u.display_name order by u.display_name)
             filter (where u.id is not null and u.id <> ${userId}), '{}') as members
    from ${memberships} me
    join ${conversations} c on c.id = me.conversation_id
    -- Who's in it now -- only for conversations you're still in. For one you've left, listing
    -- today's members would show people who joined after you, which you were never told.
    left join ${memberships} other
      on other.conversation_id = c.id and other.left_at is null and me.left_at is null
    left join ${users} u on u.id = other.user_id
    where me.user_id = ${userId}
    group by c.id, c.type, c.title, me.joined_at, me.left_at
    order by me.joined_at
  `);
  return result.rows;
}

/** CHAT-037 review: see `lockLiveUsers` -- the other half of that handshake. */
export async function lockUserForDeletion(db: DbExecutor, userId: string): Promise<void> {
  await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

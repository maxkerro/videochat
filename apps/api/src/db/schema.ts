import {
  AUTH_TOKEN_PURPOSES,
  CONVERSATION_TYPES,
  DEVICE_PLATFORMS,
  MEMBER_ROLES,
  MESSAGE_TYPES,
} from '@videochat/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Schema v1 (CHAT-004).
 *
 * Ordering rule: messages are ordered by `seq`, a per-conversation counter assigned by the
 * server inside the insert transaction (see `appendMessage`). Timestamps are for display only.
 */

export const conversationType = pgEnum('conversation_type', CONVERSATION_TYPES);
export const memberRole = pgEnum('member_role', MEMBER_ROLES);
export const messageType = pgEnum('message_type', MESSAGE_TYPES);
export const devicePlatform = pgEnum('device_platform', DEVICE_PLATFORMS);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    avatarKey: text('avatar_key'),
    passwordHash: text('password_hash'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Consecutive failed login attempts; reset to 0 on a successful login (CHAT-010). */
    failedLoginAttempts: bigint('failed_login_attempts', { mode: 'number' }).notNull().default(0),
    /** Set after too many failed attempts; login is refused until this passes. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Case-insensitive uniqueness without the citext extension.
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    uniqueIndex('users_username_lower_uq').on(sql`lower(${t.username})`),
  ],
);

/**
 * One row per issued refresh token (CHAT-010). Only a SHA-256 hash of the opaque token is
 * stored, never the token itself, so a leaked database row can't be replayed.
 *
 * `familyId` links every token descended from the same login through however many rotations:
 * on refresh the current token is revoked and a new one in the same family replaces it, and
 * presenting an already-revoked token (a replay of a stolen or reused token) revokes the whole
 * family, ending that session everywhere rather than just rejecting the one request.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_uq').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

export const authTokenPurpose = pgEnum('auth_token_purpose', AUTH_TOKEN_PURPOSES);

/**
 * Single-use, short-lived tokens for email verification and password reset (CHAT-010).
 * Only a hash of the token is stored; the plaintext is only ever in the emailed link.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: authTokenPurpose('purpose').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_uq').on(t.tokenHash),
    index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: devicePlatform('platform').notNull(),
    pushToken: text('push_token'),
    userAgent: text('user_agent'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('devices_user_idx').on(t.userId),
    uniqueIndex('devices_push_token_uq')
      .on(t.pushToken)
      .where(sql`${t.pushToken} IS NOT NULL`),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: conversationType('type').notNull(),
    title: text('title'),
    avatarKey: text('avatar_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * For direct chats: the two member ids sorted and joined with ':'.
     * The unique index makes "one DM per pair of users" a database guarantee.
     */
    directKey: text('direct_key'),
    /** Highest seq assigned in this conversation. Incremented atomically on every append. */
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('conversations_direct_key_uq').on(t.directKey),
    index('conversations_last_message_idx').on(t.lastMessageAt.desc()),
    check(
      'conversations_direct_key_ck',
      sql`(${t.type} = 'direct') = (${t.directKey} IS NOT NULL)`,
    ),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the user leaves or is removed; history before this point stays visible to them. */
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    // "My conversations" lookups go by user first.
    index('memberships_user_idx').on(t.userId, t.conversationId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    /** ULID generated by the server: sortable, URL-safe, 26 chars. */
    id: char('id', { length: 26 }).primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** Null for system messages ("Anna added Ben"). */
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    /** Client-generated id for idempotent retries; unique per sender. */
    clientMsgId: text('client_msg_id'),
    type: messageType('type').notNull().default('text'),
    body: text('body'),
    replyToId: char('reply_to_id', { length: 26 }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Guarantees ordering integrity and also serves history paging
    // (WHERE conversation_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 50) via a backward index scan,
    // so no separate DESC index is needed.
    uniqueIndex('messages_conversation_seq_uq').on(t.conversationId, t.seq),
    uniqueIndex('messages_sender_client_msg_uq')
      .on(t.senderId, t.clientMsgId)
      .where(sql`${t.clientMsgId} IS NOT NULL`),
    foreignKey({
      columns: [t.replyToId],
      foreignColumns: [t.id],
      name: 'messages_reply_to_fk',
    }).onDelete('set null'),
    check('messages_body_length_ck', sql`${t.body} IS NULL OR char_length(${t.body}) <= 4000`),
    check('messages_seq_positive_ck', sql`${t.seq} > 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type AuthTokenRow = typeof authTokens.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

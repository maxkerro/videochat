import {
  AUTH_TOKEN_PURPOSES,
  CALL_END_REASONS,
  CALL_MEDIA,
  CALL_STATUSES,
  CONVERSATION_TYPES,
  DEVICE_PLATFORMS,
  MEMBER_ROLES,
  MESSAGE_TYPES,
  type CallMessageMeta,
} from '@videochat/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  jsonb,
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
    /** Structured data for non-text message types. CHAT-044: `{ call: CallMessageMeta }` on a
     *  `call` message. Null for ordinary text. */
    meta: jsonb('meta').$type<{ call?: CallMessageMeta }>(),
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

/**
 * CHAT-021: a directional block -- `blockerId` blocked `blockedId`, which says nothing about the
 * reverse (A blocking B never implies B has blocked A). The primary key on
 * `(blockerId, blockedId)` gives an index-only "is X blocked by Y" lookup keyed exactly that way
 * (the composite index's leading column is `blockerId`), which is the check enforcement runs on
 * every DM-start, group-add and message-send. `blocks_blocked_idx` mirrors that in the other
 * column order so "who has blocked me" (the blocklist UI, and the reverse-direction half of a
 * "do either of us block the other" check) is equally an index lookup rather than a scan.
 */
export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index('blocks_blocked_idx').on(t.blockedId, t.blockerId),
    check('blocks_not_self_ck', sql`${t.blockerId} <> ${t.blockedId}`),
  ],
);

export const callMedia = pgEnum('call_media', CALL_MEDIA);
export const callStatus = pgEnum('call_status', CALL_STATUSES);
export const callEndReason = pgEnum('call_end_reason', CALL_END_REASONS);

/**
 * CHAT-041: one row per call attempt, and the single source of truth for its state. Every
 * transition (answer, decline, hang up, time out) is one conditional UPDATE -- e.g.
 * `SET status='active' WHERE id=$1 AND status='ringing'` -- so when two of the callee's devices
 * answer at the same moment, or an answer races the ring timeout, exactly one wins, on whichever
 * API node each request landed. No separate lock or Redis state to keep in sync.
 *
 * `*ConnectionId` are realtime socket ids (not user ids): media negotiation is relayed only to
 * the one device actually in the call on each side. `*DisconnectedAt` is set when that socket
 * drops mid-call and cleared when it re-attaches (`call.resume`); a call whose participant stays
 * gone past the reconnect grace period is ended as `connection-lost`.
 */
export const calls = pgTable(
  'calls',
  {
    /** Generated by the caller's client so it can match signalling to the call immediately. */
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calleeId: uuid('callee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    media: callMedia('media').notNull(),
    status: callStatus('status').notNull().default('ringing'),
    endReason: callEndReason('end_reason'),
    callerConnectionId: text('caller_connection_id').notNull(),
    calleeConnectionId: text('callee_connection_id'),
    callerDisconnectedAt: timestamp('caller_disconnected_at', { withTimezone: true }),
    calleeDisconnectedAt: timestamp('callee_disconnected_at', { withTimezone: true }),
    /** CHAT-021: true when the callee has blocked the caller. The caller still "rings" (blocking
     *  is silent), but the callee is never notified and nothing is logged to the conversation. */
    silenced: boolean('silenced').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    // The timeout sweep and busy checks only ever look at calls that aren't over yet.
    index('calls_open_idx')
      .on(t.status, t.createdAt)
      .where(sql`${t.status} <> 'ended'`),
    index('calls_open_caller_idx')
      .on(t.callerId)
      .where(sql`${t.status} <> 'ended'`),
    index('calls_open_callee_idx')
      .on(t.calleeId)
      .where(sql`${t.status} <> 'ended'`),
    index('calls_conversation_idx').on(t.conversationId, t.createdAt),
    check('calls_ended_has_reason_ck', sql`(${t.status} = 'ended') = (${t.endReason} IS NOT NULL)`),
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
export type BlockRow = typeof blocks.$inferSelect;
export type CallRow = typeof calls.$inferSelect;

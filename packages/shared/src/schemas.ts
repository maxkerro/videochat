import { z } from 'zod';
import {
  ATTACHMENT_KINDS,
  CALL_END_REASONS,
  CALL_MEDIA,
  CONVERSATION_TYPES,
  LIMITS,
  MEMBER_ROLES,
  MESSAGE_TYPES,
} from './domain.js';

/**
 * CHAT-044: what a `type: 'call'` message records about the call it summarises. One message is
 * shared by both participants, so it stores facts (who called, how it ended) and each client
 * words it from its own side ("Missed video call" for the callee, "No answer" for the caller).
 * - `missed`: never answered (timed out, the caller hung up first, or the callee was busy).
 * - `declined`: the callee rejected it.
 * - `completed`: it was answered; `durationSec` is how long it lasted.
 */
export const callMessageMetaSchema = z.object({
  callId: z.uuid(),
  media: z.enum(CALL_MEDIA),
  outcome: z.enum(['missed', 'declined', 'completed']),
  endReason: z.enum(CALL_END_REASONS),
  callerId: z.uuid(),
  durationSec: z.number().int().nonnegative().nullable(),
});
export type CallMessageMeta = z.infer<typeof callMessageMetaSchema>;

export const usernameSchema = z
  .string()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, digits and underscores only');

export const displayNameSchema = z.string().trim().min(1).max(LIMITS.displayNameMax);

export const emailSchema = z.email().max(254);

/** A 26-character Crockford base32 ULID (message ids). */
export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Invalid ULID');

export const publicUserSchema = z.object({
  id: z.uuid(),
  username: usernameSchema,
  displayName: displayNameSchema,
  avatarUrl: z.url().nullable(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/** The signed-in user's own view of themselves: everything in PublicUser plus private fields. */
export const meSchema = publicUserSchema.extend({
  email: emailSchema,
  emailVerified: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMin, `At least ${LIMITS.passwordMin} characters`)
  .max(LIMITS.passwordMax);

export const signUpSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});
export type SignUpInput = z.infer<typeof signUpSchema>;

/**
 * CHAT-080: what the login form's "Email or username" field holds. Usernames can't contain '@'
 * (see `usernameSchema`), so the server tells the two apart by that alone -- see
 * {@link isEmailIdentifier}. Deliberately not validated as either format here: a malformed
 * value just fails to match anyone, with the same generic error as a wrong password.
 */
export const loginIdentifierSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email or username')
  .max(254);

/** True when a login identifier is an email address rather than a username. */
export function isEmailIdentifier(identifier: string): boolean {
  return identifier.includes('@');
}

export const loginSchema = z.object({
  identifier: loginIdentifierSchema,
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * What `POST /auth/login` accepts: `{identifier, password}`, or the pre-CHAT-080 shape
 * `{email, password}` so a web tab loaded before the deploy (or an older mobile build) keeps
 * working. Normalised to {@link LoginInput}; if both are sent, `identifier` wins. Note the legacy
 * `email` field is no longer validated as an email: it's just an identifier, so `{email: "ada"}`
 * is a username login (harmless -- same lookup, same generic error). The legacy field can be
 * dropped once no client sends it.
 */
export const loginRequestSchema = z
  .object({
    identifier: loginIdentifierSchema.optional(),
    email: loginIdentifierSchema.optional(),
    password: z.string().min(1, 'Enter your password'),
  })
  .refine((v) => v.identifier !== undefined || v.email !== undefined, {
    message: 'Enter your email or username',
    path: ['identifier'],
  })
  .transform((v): LoginInput => ({ identifier: (v.identifier ?? v.email)!, password: v.password }));

export const requestPasswordResetSchema = z.object({ email: emailSchema });
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(1) });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: displayNameSchema.optional(),
  })
  .refine((v) => v.username !== undefined || v.displayName !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const usernameAvailabilitySchema = z.object({ available: z.boolean() });
export type UsernameAvailability = z.infer<typeof usernameAvailabilitySchema>;

/** Returned after login/refresh: the caller keeps the access token in memory and sends it as
 *  `Authorization: Bearer <token>`. The refresh token itself travels only in an httpOnly cookie. */
export const authSessionSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  user: meSchema,
});
export type AuthSession = z.infer<typeof authSessionSchema>;

/**
 * CHAT-030: what a message says about the file it carries. The bytes themselves are only ever
 * reachable through a short-lived signed URL from `GET /attachments/:id/url`, which re-checks
 * conversation membership on every call.
 */
export const attachmentSchema = z.object({
  id: z.uuid(),
  kind: z.enum(ATTACHMENT_KINDS),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  /** Images only (after EXIF orientation is applied); null for files. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** CHAT-030 step 1: ask for somewhere to upload a file before sending it. */
export const createAttachmentUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(
      LIMITS.attachmentMaxBytes,
      `Files can be up to ${LIMITS.attachmentMaxBytes / (1024 * 1024)} MB`,
    ),
});
export type CreateAttachmentUploadInput = z.infer<typeof createAttachmentUploadSchema>;

/** CHAT-030: where to PUT the bytes (straight to object storage, never through the API), and
 *  the headers that PUT must carry for the signature to match. */
export const attachmentUploadSchema = z.object({
  attachmentId: z.uuid(),
  uploadUrl: z.url(),
  uploadHeaders: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

export const ATTACHMENT_VARIANTS = ['original', 'thumb'] as const;
export const attachmentUrlQuerySchema = z.object({
  variant: z.enum(ATTACHMENT_VARIANTS).default('original'),
});
export const attachmentUrlSchema = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type AttachmentUrl = z.infer<typeof attachmentUrlSchema>;

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  type: z.enum(CONVERSATION_TYPES),
  title: z.string().nullable(),
  lastSeq: z.number().int().nonnegative(),
  lastMessageAt: z.iso.datetime().nullable(),
  role: z.enum(MEMBER_ROLES),
  lastReadSeq: z.number().int().nonnegative(),
  /** The other member, for a direct conversation (null for a group, which uses `title` instead).
   *  A direct conversation has no title of its own, so the client needs this to show who it's
   *  with. */
  peer: publicUserSchema.nullable(),
  /** CHAT-019: the peer's own `lastReadSeq`, for a direct conversation's "Seen" indicator (once
   *  it's >= `lastSeq`, the peer has read everything). Always `null` for a group -- "Seen by N"
   *  there needs every member's position, not just one, so it comes from the members endpoint
   *  instead (see `memberSummarySchema.lastReadSeq`). Defaults to `null` so older cached/mocked
   *  responses without this field still parse. */
  peerLastReadSeq: z.number().int().nonnegative().nullable().default(null),
  /** CHAT-044 (and CHAT-015's "last message preview"): the newest message, for the inbox
   *  preview line. Null for a conversation with no messages yet; defaults to null so older
   *  cached/mocked responses without this field still parse. */
  lastMessage: z
    .object({
      type: z.enum(MESSAGE_TYPES),
      senderId: z.uuid().nullable(),
      body: z.string().max(LIMITS.messageMaxLength).nullable(),
      call: callMessageMetaSchema.optional(),
      /** CHAT-030: enough to preview "Photo" / "report.pdf" without the whole attachment. */
      attachment: attachmentSchema.pick({ kind: true, filename: true }).optional(),
    })
    .nullable()
    .default(null),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export const conversationsListSchema = z.array(conversationSummarySchema);
export type ConversationsList = z.infer<typeof conversationsListSchema>;

/** CHAT-012: search by username (prefix match) or exact email (never partial, to avoid
 *  enumerating accounts by email). */
export const userSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(254) });
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;
export const userSearchResultsSchema = z.object({ users: z.array(publicUserSchema) });
export type UserSearchResults = z.infer<typeof userSearchResultsSchema>;

/** CHAT-012: start (or reopen) a direct conversation with another user. */
export const startDirectConversationSchema = z.object({ userId: z.uuid() });
export type StartDirectConversationInput = z.infer<typeof startDirectConversationSchema>;

export const groupTitleSchema = z.string().trim().min(1).max(LIMITS.groupTitleMax);

/** CHAT-018: create a group. `memberIds` is everyone *other* than the creator (who is implied
 *  and always becomes admin), so the cap check below is against `LIMITS.groupMaxMembers - 1` --
 *  the creator themself takes up one of the 100 seats. */
export const createGroupConversationSchema = z.object({
  title: groupTitleSchema,
  memberIds: z
    .array(z.uuid())
    .min(1, 'A group needs at least one other member')
    .max(LIMITS.groupMaxMembers - 1, `A group can have at most ${LIMITS.groupMaxMembers} members`)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate member'),
});
export type CreateGroupConversationInput = z.infer<typeof createGroupConversationSchema>;

/** CHAT-018: admin-only rename. */
export const renameConversationSchema = z.object({ title: groupTitleSchema });
export type RenameConversationInput = z.infer<typeof renameConversationSchema>;

/** CHAT-018: admin-only "add members" -- one or more at a time, capped the same way creation is
 *  (enforced against the group's *current* member count server-side, since the schema alone can't
 *  know how many seats are already taken). */
export const addMembersSchema = z.object({
  memberIds: z
    .array(z.uuid())
    .min(1)
    .max(LIMITS.groupMaxMembers - 1)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate member'),
});
export type AddMembersInput = z.infer<typeof addMembersSchema>;

/** CHAT-018: one row of a group's "members list shows roles" AC. */
export const memberSummarySchema = z.object({
  userId: z.uuid(),
  username: usernameSchema,
  displayName: displayNameSchema,
  avatarUrl: z.url().nullable(),
  role: z.enum(MEMBER_ROLES),
  joinedAt: z.iso.datetime(),
  /** CHAT-019: this member's own `lastReadSeq` -- the "Seen by N" list is everyone here whose
   *  `lastReadSeq` is at least the conversation's `lastSeq`. Defaults to 0 so older cached/mocked
   *  responses without this field still parse. */
  lastReadSeq: z.number().int().nonnegative().default(0),
});
export type MemberSummary = z.infer<typeof memberSummarySchema>;
export const membersListSchema = z.array(memberSummarySchema);
export type MembersList = z.infer<typeof membersListSchema>;

export const messageSchema = z.object({
  id: ulidSchema,
  conversationId: z.uuid(),
  seq: z.number().int().positive(),
  senderId: z.uuid().nullable(),
  clientMsgId: z.string().max(64).nullable(),
  type: z.enum(MESSAGE_TYPES),
  body: z.string().max(LIMITS.messageMaxLength).nullable(),
  replyToId: ulidSchema.nullable(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** CHAT-044: present only on `type: 'call'` messages. */
  call: callMessageMetaSchema.optional(),
  /** CHAT-030: present only on `image`/`file` messages (and gone once the message is deleted). */
  attachment: attachmentSchema.optional(),
});
export type Message = z.infer<typeof messageSchema>;

/** CHAT-016: a cursor-paged page of history, oldest first. `hasMore` tells the client whether
 *  requesting messages before the oldest one in this page would return anything -- computed by
 *  the server fetching one extra row, never by comparing the page length to the page size (which
 *  would be wrong on a conversation whose remaining history is an exact multiple of the page
 *  size). */
export const messagePageSchema = z.object({
  messages: z.array(messageSchema),
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

/** CHAT-016: the `before` query param for paging further back in history -- the `seq` of the
 *  oldest message already loaded. Omitted for the first page (the most recent messages).
 *
 *  CHAT-017: `after` is the reconnect/gap-sync counterpart -- the `seq` of the last message the
 *  client already has -- and returns messages *ascending* (oldest of the missed ones first),
 *  ready to append in order, rather than `before`'s newest-first history page. The two are
 *  mutually exclusive: a request is either paging further into the past or catching up on what
 *  it missed, never both at once. */
export const messagesPageQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().nonnegative().optional(),
  })
  .refine((v) => v.before === undefined || v.after === undefined, {
    message: 'Pass only one of `before` or `after`',
  });
export type MessagesPageQuery = z.infer<typeof messagesPageQuerySchema>;

/** `clientMsgId` prefixes the server uses for its own idempotency keys; clients can't send them. */
export const RESERVED_CLIENT_MSG_ID_PREFIXES = ['call:'] as const;

/** CHAT-014: send a text message. `clientMsgId` is generated by the client and is what makes
 *  retrying a failed send safe -- the server returns the original message instead of creating
 *  a duplicate for the same (sender, clientMsgId) pair. */
export const sendMessageSchema = z
  .object({
    clientMsgId: z
      .string()
      .min(1)
      .max(64)
      // Server-originated entries (call history) use `call:<callId>` keys under the caller's id;
      // a client mustn't be able to pre-claim one of them.
      .refine((v) => !RESERVED_CLIENT_MSG_ID_PREFIXES.some((prefix) => v.startsWith(prefix)), {
        message: 'clientMsgId uses a reserved prefix',
      }),
    /** Optional when the message carries an attachment (CHAT-030), which can have no caption. */
    body: z.string().trim().min(1).max(LIMITS.messageMaxLength).optional(),
    /** CHAT-030: an attachment uploaded by this sender to this conversation (see
     *  `createAttachmentUploadSchema`). One per message; send several files as several messages. */
    attachmentId: z.uuid().optional(),
  })
  .refine((v) => v.body !== undefined || v.attachmentId !== undefined, {
    message: 'Write a message or attach a file',
    path: ['body'],
  });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * CHAT-019: "mark read up to `seq`" -- the highest message `seq` currently visible (in the
 * viewport) and read on this device. The server only ever advances `lastReadSeq` forward from
 * this (see `markConversationRead`'s GREATEST guard), so sending a `seq` lower than what's already
 * recorded is harmless, just a no-op.
 */
export const markConversationReadSchema = z.object({
  seq: z.number().int().nonnegative(),
});
export type MarkConversationReadInput = z.infer<typeof markConversationReadSchema>;

/**
 * CHAT-019: the realtime payload broadcast (as a `conversation.read` `WsEnvelope`) whenever a
 * member's `lastReadSeq` changes -- forward from reading, or backward from "mark as unread". Sent
 * via `RealtimeService.publishToConversation`, so it reaches both the reader's own other open
 * devices/tabs (clearing their unread badge for the same conversation without a refetch) and every
 * other member (updating a group's live "Seen by N").
 */
export const conversationReadEventSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
  lastReadSeq: z.number().int().nonnegative(),
});
export type ConversationReadEvent = z.infer<typeof conversationReadEventSchema>;

/**
 * CHAT-020: "someone is typing" -- purely ephemeral, never persisted (no DB table, no message
 * row). The client sends `typingSignalSchema` (just the conversation it's typing in) over the
 * already-open realtime socket; the server never trusts a client-supplied identity, so it fills
 * in `userId`/`displayName` itself from the authenticated connection before re-broadcasting this
 * shape (as a `conversation.typing` `WsEnvelope`, matching `conversation.read`'s noun.verb naming)
 * to the rest of the conversation via `RealtimeService.publishToConversation`. `displayName`
 * travels inline rather than just `userId` because there's no persisted row for the receiving
 * client to join against afterwards -- this event is gone the moment it's delivered.
 */
export const typingSignalSchema = z.object({ conversationId: z.uuid() });
export type TypingSignalInput = z.infer<typeof typingSignalSchema>;

export const typingEventSchema = z.object({
  conversationId: z.uuid(),
  userId: z.uuid(),
  displayName: displayNameSchema,
});
export type TypingEvent = z.infer<typeof typingEventSchema>;

/** CHAT-021: the "who I've blocked" list -- reuses `publicUserSchema` since a blocked user is
 *  shown exactly like anyone else (avatar, display name, username), just with an "Unblock"
 *  action instead of whatever a normal result row offers. */
export const blockedUsersListSchema = z.object({ users: z.array(publicUserSchema) });
export type BlockedUsersList = z.infer<typeof blockedUsersListSchema>;

/** Health endpoint contract, consumed by the web shell's status indicator. */
export const dependencyStatusSchema = z.enum(['up', 'down']);
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.record(z.string(), dependencyStatusSchema),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

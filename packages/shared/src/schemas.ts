import { z } from 'zod';
import { CONVERSATION_TYPES, LIMITS, MEMBER_ROLES, MESSAGE_TYPES } from './domain.js';

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

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

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

/** CHAT-014: send a text message. `clientMsgId` is generated by the client and is what makes
 *  retrying a failed send safe -- the server returns the original message instead of creating
 *  a duplicate for the same (sender, clientMsgId) pair. */
export const sendMessageSchema = z.object({
  clientMsgId: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(LIMITS.messageMaxLength),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** Health endpoint contract, consumed by the web shell's status indicator. */
export const dependencyStatusSchema = z.enum(['up', 'down']);
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.record(z.string(), dependencyStatusSchema),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

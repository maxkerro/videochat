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

/** Health endpoint contract, consumed by the web shell's status indicator. */
export const dependencyStatusSchema = z.enum(['up', 'down']);
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.record(z.string(), dependencyStatusSchema),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

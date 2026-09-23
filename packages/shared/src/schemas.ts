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

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  type: z.enum(CONVERSATION_TYPES),
  title: z.string().nullable(),
  lastSeq: z.number().int().nonnegative(),
  lastMessageAt: z.iso.datetime().nullable(),
  role: z.enum(MEMBER_ROLES),
  lastReadSeq: z.number().int().nonnegative(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

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

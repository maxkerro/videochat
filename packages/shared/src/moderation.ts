import { z } from 'zod';
import { LIMITS } from './domain.js';
import { REPORT_REASONS, ulidSchema } from './schemas.js';

/**
 * CHAT-077: reports and the moderation console. Moderators see a reported message plus at most
 * `MODERATION.contextMessages` messages around it -- never the rest of the conversation -- and
 * every moderator action (opening a report included) goes to the audit log.
 */
export const MODERATION = {
  /** Messages shown around a reported one ("5 surrounding messages"). */
  contextMessages: 5,
  maxSuspendDays: 365,
  noteMax: 1000,
  pageSize: 50,
} as const;

export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What a moderator can do with a report. `dismiss` closes it without acting on anyone. */
export const MODERATION_ACTIONS = ['dismiss', 'warn', 'suspend', 'ban'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Everything that lands in the audit log. */
export const AUDIT_ACTIONS = [...MODERATION_ACTIONS, 'view_report', 'lift'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** `POST /users/:id/report`: report a person (from a chat you share with them). */
export const reportUserSchema = z.object({
  conversationId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional(),
});
export type ReportUserInput = z.infer<typeof reportUserSchema>;

export const reportsQuerySchema = z.object({
  status: z.enum(REPORT_STATUSES).default('open'),
  /** Opaque: the last report's `createdAt|id` from the previous page. */
  cursor: z.string().max(100).optional(),
});
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;

export const resolveReportSchema = z
  .object({
    action: z.enum(MODERATION_ACTIONS),
    note: z.string().trim().max(MODERATION.noteMax).optional(),
    /** Required for `suspend`. */
    days: z.number().int().min(1).max(MODERATION.maxSuspendDays).optional(),
  })
  .refine((v) => v.action !== 'suspend' || v.days !== undefined, {
    message: 'Choose how many days to suspend for',
    path: ['days'],
  });
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;

export const liftRestrictionSchema = z.object({
  note: z.string().trim().max(MODERATION.noteMax).optional(),
});
export type LiftRestrictionInput = z.infer<typeof liftRestrictionSchema>;

export const moderationUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  deleted: z.boolean(),
  suspendedUntil: z.iso.datetime().nullable(),
  bannedAt: z.iso.datetime().nullable(),
});
export type ModerationUser = z.infer<typeof moderationUserSchema>;

export const reportSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['message', 'user']),
  status: z.enum(REPORT_STATUSES),
  reason: z.enum(REPORT_REASONS),
  details: z.string().nullable(),
  createdAt: z.iso.datetime(),
  reporter: moderationUserSchema.nullable(),
  reportedUser: moderationUserSchema.nullable(),
  conversationId: z.uuid(),
  messageId: ulidSchema.nullable(),
  /** Open reports about the same person, this one included: repeat offenders stand out. */
  openReportsAboutUser: z.number().int().nonnegative(),
  resolution: z
    .object({
      action: z.enum(MODERATION_ACTIONS),
      note: z.string().nullable(),
      by: moderationUserSchema.nullable(),
      at: z.iso.datetime(),
    })
    .nullable(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const reportsPageSchema = z.object({
  reports: z.array(reportSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ReportsPage = z.infer<typeof reportsPageSchema>;

export const contextMessageSchema = z.object({
  id: ulidSchema,
  seq: z.number().int().positive(),
  senderId: z.uuid().nullable(),
  senderName: z.string().nullable(),
  type: z.string(),
  text: z.string().max(LIMITS.messageMaxLength).nullable(),
  attachmentName: z.string().nullable(),
  encrypted: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.iso.datetime(),
  /** The reported message itself. */
  reported: z.boolean(),
});
export type ContextMessage = z.infer<typeof contextMessageSchema>;

export const reportDetailSchema = reportSummarySchema.extend({
  /** The reported text as it was when reported (the sender may have edited or deleted it). */
  snapshot: z
    .object({
      text: z.string().nullable(),
      /** Typed in by the reporter (an end-to-end encrypted message the server can't read):
       *  unverified. */
      fromReporter: z.boolean(),
    })
    .nullable(),
  /** The reported message and at most `MODERATION.contextMessages` around it, oldest first. */
  context: z.array(contextMessageSchema),
});
export type ReportDetail = z.infer<typeof reportDetailSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  action: z.enum(AUDIT_ACTIONS),
  moderator: moderationUserSchema.nullable(),
  targetUser: moderationUserSchema.nullable(),
  reportId: z.uuid().nullable(),
  note: z.string().nullable(),
  /** e.g. `{ days: 7 }` for a suspension. */
  details: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

export const auditQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  userId: z.uuid().optional(),
});

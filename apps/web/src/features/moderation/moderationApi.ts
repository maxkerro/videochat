import {
  auditPageSchema,
  reportDetailSchema,
  reportSummarySchema,
  reportsPageSchema,
  type AuditPage,
  type ReportDetail,
  type ReportMessageInput,
  type ReportStatus,
  type ReportSummary,
  type ReportsPage,
  type ReportUserInput,
  type ResolveReportInput,
} from '@videochat/shared';
import { z } from 'zod';
import { apiGet, apiPost } from '../../lib/api';

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** CHAT-058/077: report someone else's message. */
export function reportMessage(
  token: string,
  conversationId: string,
  messageId: string,
  input: ReportMessageInput,
): Promise<unknown> {
  return apiPost(
    `/conversations/${conversationId}/messages/${messageId}/report`,
    z.unknown(),
    input,
    auth(token),
  );
}

/** CHAT-077: report a person (from a chat you share). */
export function reportUser(
  token: string,
  userId: string,
  input: ReportUserInput,
): Promise<unknown> {
  return apiPost(`/users/${userId}/report`, z.unknown(), input, auth(token));
}

export function fetchReports(
  token: string,
  status: ReportStatus,
  cursor?: string,
): Promise<ReportsPage> {
  const params = new URLSearchParams({ status });
  if (cursor) params.set('cursor', cursor);
  return apiGet(`/moderation/reports?${params.toString()}`, reportsPageSchema, auth(token));
}

export function fetchReport(token: string, id: string): Promise<ReportDetail> {
  return apiGet(`/moderation/reports/${id}`, reportDetailSchema, auth(token));
}

export function resolveReport(
  token: string,
  id: string,
  input: ResolveReportInput,
): Promise<ReportSummary> {
  return apiPost(`/moderation/reports/${id}/resolve`, reportSummarySchema, input, auth(token));
}

export function liftRestriction(token: string, userId: string, note?: string): Promise<unknown> {
  return apiPost(
    `/moderation/users/${userId}/lift`,
    z.unknown(),
    note ? { note } : {},
    auth(token),
  );
}

export function fetchAudit(token: string, cursor?: string, userId?: string): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (userId) params.set('userId', userId);
  const q = params.size ? `?${params.toString()}` : '';
  return apiGet(`/moderation/audit${q}`, auditPageSchema, auth(token));
}

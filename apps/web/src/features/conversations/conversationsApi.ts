import {
  addMembersSchema,
  conversationSummarySchema,
  conversationsListSchema,
  createGroupConversationSchema,
  markConversationReadSchema,
  membersListSchema,
  renameConversationSchema,
  startDirectConversationSchema,
  userSearchResultsSchema,
  type AddMembersInput,
  type ConversationSummary,
  type ConversationsList,
  type CreateGroupConversationInput,
  type MarkConversationReadInput,
  type MembersList,
  type RenameConversationInput,
  type StartDirectConversationInput,
  type UserSearchResults,
} from '@videochat/shared';
import { z } from 'zod';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../../lib/api';

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export function fetchConversations(accessToken: string): Promise<ConversationsList> {
  return apiGet('/conversations', conversationsListSchema, { headers: authHeader(accessToken) });
}

export function fetchConversation(
  accessToken: string,
  conversationId: string,
): Promise<ConversationSummary> {
  return apiGet(`/conversations/${conversationId}`, conversationSummarySchema, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-012: username prefix or exact email. Empty query returns no results without a request. */
export function searchUsers(accessToken: string, query: string): Promise<UserSearchResults> {
  return apiGet(`/users/search?q=${encodeURIComponent(query)}`, userSearchResultsSchema, {
    headers: authHeader(accessToken),
  });
}

export function startDirectConversation(
  accessToken: string,
  input: StartDirectConversationInput,
): Promise<ConversationSummary> {
  startDirectConversationSchema.parse(input);
  return apiPost('/conversations/direct', conversationSummarySchema, input, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-018: `memberIds` is everyone other than the caller, who becomes admin automatically. */
export function createGroupConversation(
  accessToken: string,
  input: CreateGroupConversationInput,
): Promise<ConversationSummary> {
  createGroupConversationSchema.parse(input);
  return apiPost('/conversations/group', conversationSummarySchema, input, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-018: "members list shows roles" AC. */
export function fetchMembers(accessToken: string, conversationId: string): Promise<MembersList> {
  return apiGet(`/conversations/${conversationId}/members`, membersListSchema, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-018: admin-only rename. */
export function renameConversation(
  accessToken: string,
  conversationId: string,
  input: RenameConversationInput,
): Promise<ConversationSummary> {
  renameConversationSchema.parse(input);
  return apiPatch(`/conversations/${conversationId}`, conversationSummarySchema, input, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-018: admin-only "add members". */
export function addMembers(
  accessToken: string,
  conversationId: string,
  input: AddMembersInput,
): Promise<ConversationSummary> {
  addMembersSchema.parse(input);
  return apiPost(`/conversations/${conversationId}/members`, conversationSummarySchema, input, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-018: admin-only removal of someone else. */
export function removeMember(
  accessToken: string,
  conversationId: string,
  targetUserId: string,
): Promise<void> {
  return apiDelete(`/conversations/${conversationId}/members/${targetUserId}`, z.undefined(), {
    headers: authHeader(accessToken),
  });
}

/** CHAT-018: any member can leave, no admin check. */
export function leaveConversation(accessToken: string, conversationId: string): Promise<void> {
  return apiPost(`/conversations/${conversationId}/leave`, z.undefined(), undefined, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-019: advances the caller's own read position -- called by `ChatPane`'s read-tracking
 *  (throttled to at most once/sec per conversation) as messages become visible in the viewport. */
export function markConversationRead(
  accessToken: string,
  conversationId: string,
  input: MarkConversationReadInput,
): Promise<ConversationSummary> {
  markConversationReadSchema.parse(input);
  return apiPost(`/conversations/${conversationId}/read`, conversationSummarySchema, input, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-019: "Mark as unread" from the conversation menu. */
export function markConversationUnread(
  accessToken: string,
  conversationId: string,
): Promise<ConversationSummary> {
  return apiPost(`/conversations/${conversationId}/unread`, conversationSummarySchema, undefined, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-035: mute (no notifications) or unmute a conversation. */
export function setConversationMuted(
  accessToken: string,
  conversationId: string,
  muted: boolean,
): Promise<ConversationSummary> {
  return apiPut(
    `/conversations/${conversationId}/mute`,
    conversationSummarySchema,
    { muted },
    {
      headers: authHeader(accessToken),
    },
  );
}

import {
  conversationSummarySchema,
  conversationsListSchema,
  startDirectConversationSchema,
  userSearchResultsSchema,
  type ConversationSummary,
  type ConversationsList,
  type StartDirectConversationInput,
  type UserSearchResults,
} from '@videochat/shared';
import { apiGet, apiPost } from '../../lib/api';

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

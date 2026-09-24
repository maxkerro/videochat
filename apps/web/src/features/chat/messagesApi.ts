import {
  messageListSchema,
  messageSchema,
  sendMessageSchema,
  type Message,
  type MessageList,
  type SendMessageInput,
} from '@videochat/shared';
import { apiGet, apiPost } from '../../lib/api';

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

export function fetchMessages(accessToken: string, conversationId: string): Promise<MessageList> {
  return apiGet(`/conversations/${conversationId}/messages`, messageListSchema, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-014: `input.clientMsgId` makes a retried call safe -- the server returns the original
 *  message instead of creating a duplicate. */
export function sendMessage(
  accessToken: string,
  conversationId: string,
  input: SendMessageInput,
): Promise<Message> {
  sendMessageSchema.parse(input);
  return apiPost(`/conversations/${conversationId}/messages`, messageSchema, input, {
    headers: authHeader(accessToken),
  });
}

import {
  messagePageSchema,
  messageSchema,
  sendMessageSchema,
  type Message,
  type MessagePage,
  type SendMessageInput,
} from '@videochat/shared';
import { apiGet, apiPost } from '../../lib/api';

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

/** CHAT-016: `before` pages further back in history -- the `seq` of the oldest message already
 *  loaded. Omitted for the first (most recent) page. */
export function fetchMessages(
  accessToken: string,
  conversationId: string,
  before?: number,
): Promise<MessagePage> {
  const query = before !== undefined ? `?before=${before}` : '';
  return apiGet(`/conversations/${conversationId}/messages${query}`, messagePageSchema, {
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

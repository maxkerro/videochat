import {
  messagePageSchema,
  messageReactionsSchema,
  type MessageReactions,
  messageSchema,
  sendMessageSchema,
  type Message,
  type MessagePage,
  type SendMessageInput,
} from '@videochat/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api';

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

/** CHAT-017: everything after `afterSeq`, ascending -- the gap-sync counterpart to
 *  {@link fetchMessages}'s `before`. Used to catch up a conversation after a reconnect. */
export function fetchMessagesAfter(
  accessToken: string,
  conversationId: string,
  afterSeq: number,
): Promise<MessagePage> {
  return apiGet(`/conversations/${conversationId}/messages?after=${afterSeq}`, messagePageSchema, {
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

/** CHAT-032: edit your own message's text (within the edit window). */
export function editMessage(
  accessToken: string,
  conversationId: string,
  messageId: string,
  body: string,
): Promise<Message> {
  return apiPatch(
    `/conversations/${conversationId}/messages/${messageId}`,
    messageSchema,
    { body },
    {
      headers: authHeader(accessToken),
    },
  );
}

/** CHAT-032: delete for everyone. Resolves to the tombstone. */
export function deleteMessage(
  accessToken: string,
  conversationId: string,
  messageId: string,
): Promise<Message> {
  return apiDelete(`/conversations/${conversationId}/messages/${messageId}`, messageSchema, {
    headers: authHeader(accessToken),
  });
}

/** CHAT-033: add a reaction, or remove it if you'd already reacted with that emoji. */
export function toggleReaction(
  accessToken: string,
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<MessageReactions> {
  return apiPost(
    `/conversations/${conversationId}/messages/${messageId}/reactions`,
    messageReactionsSchema,
    { emoji },
    { headers: authHeader(accessToken) },
  );
}

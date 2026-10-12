import type { Message } from '@videochat/shared';
import { getLocalStore } from '../db/expoDb';
import { createOutboxRunner } from '../outbox/flush';
import { sendMessage } from './api';
import { keys } from './keys';
import { mergeMessages, type MessagesState } from './messagesState';
import { queryClient, sameSession } from './queryClient';
import { session } from '../lib/api';

/** Puts a message the server just confirmed into the on-screen list and the on-device copy. */
export async function recordMessage(message: Message): Promise<void> {
  const startedAt = session.generation();
  queryClient.setQueryData<MessagesState>(keys.messages(message.conversationId), (old) =>
    old ? mergeMessages(old, [message]) : old,
  );
  // The inbox preview and unread state change with every message.
  void queryClient.invalidateQueries({ queryKey: keys.conversations });
  if (!sameSession(startedAt)) return;
  try {
    await (await getLocalStore()).saveMessages(message.conversationId, [message]);
  } catch {
    // the cache is best effort
  }
}

/**
 * CHAT-053: the one outbox runner. Every text message goes through the outbox -- online or not --
 * so a message is on disk before the first network attempt and survives the app being killed
 * mid-send.
 */
export const outboxRunner = createOutboxRunner({
  list: async () => (await getLocalStore()).listOutbox(),
  send: (item) =>
    sendMessage(item.conversationId, {
      clientMsgId: item.clientMsgId,
      body: item.body,
      ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    }),
  remove: async (id) => (await getLocalStore()).removeFromOutbox(id),
  markFailed: async (id, error) => (await getLocalStore()).markOutboxFailed(id, error),
  onSent: (_item, message) => recordMessage(message),
  onChange: () => void queryClient.invalidateQueries({ queryKey: keys.outbox() }),
});

export function newClientMsgId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `m-${Date.now().toString(36)}-${random}`;
}

/** Queue a text message (durably) and try to send it right away. */
export async function queueTextMessage(input: {
  conversationId: string;
  body: string;
  replyToId?: string | null;
}): Promise<void> {
  const store = await getLocalStore();
  await store.enqueue({
    clientMsgId: newClientMsgId(),
    conversationId: input.conversationId,
    body: input.body.trim(),
    replyToId: input.replyToId ?? null,
  });
  void queryClient.invalidateQueries({ queryKey: keys.outbox() });
  void outboxRunner.flush();
}

export async function retryOutboxMessage(clientMsgId: string): Promise<void> {
  await (await getLocalStore()).requeueOutbox(clientMsgId);
  void queryClient.invalidateQueries({ queryKey: keys.outbox() });
  void outboxRunner.flush();
}

export async function discardOutboxMessage(clientMsgId: string): Promise<void> {
  await (await getLocalStore()).removeFromOutbox(clientMsgId);
  void queryClient.invalidateQueries({ queryKey: keys.outbox() });
}

import type { Message } from '@videochat/shared';
import { getLocalStore } from '../db/expoDb';
import { createOutboxRunner } from '../outbox/flush';
import { sendMessage } from './api';
import { keys } from './keys';
import { mergeMessages, type MessagesState } from './messagesState';
import { queryClient, sameSession } from './queryClient';
import { session } from '../lib/api';

/** Puts a message the server just confirmed into the on-screen list and the on-device copy. */
export async function recordMessage(message: Message, startedAt: number): Promise<void> {
  // `startedAt` is the session generation from *before* the request that produced `message`: if
  // the account changed while it was in flight, the message belongs to the old account and must
  // reach neither the on-screen cache nor the new account's on-device copy.
  if (!sameSession(startedAt)) return;
  queryClient.setQueryData<MessagesState>(keys.messages(message.conversationId), (old) =>
    old ? mergeMessages(old, [message]) : old,
  );
  // The inbox preview and unread state change with every message.
  void queryClient.invalidateQueries({ queryKey: keys.conversations });
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
  generation: () => session.generation(),
  onSent: (_item, message, generation) => recordMessage(message, generation),
  onChange: () => void queryClient.invalidateQueries({ queryKey: keys.outbox() }),
});

export function newClientMsgId(): string {
  // A random UUID where the runtime has one (Hermes does on current React Native); otherwise a
  // timestamp plus random digits. Either is unique per sender in practice -- the server only
  // needs uniqueness per (sender, clientMsgId) -- and fits the 64-character limit.
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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

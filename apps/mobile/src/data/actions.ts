import type { ConversationSummary, MessageReactions } from '@videochat/shared';
import { getLocalStore } from '../db/expoDb';
import { session } from '../lib/api';
import * as api from './api';
import { keys } from './keys';
import { setReactions, type MessagesState } from './messagesState';
import { recordMessage } from './outboxRunner';
import { queryClient, sameSession } from './queryClient';

/*
 * Every action below captures the session generation BEFORE it talks to the server and hands it
 * to whatever applies the answer. If the account changed while the request was in flight (sign-out,
 * then another sign-in on a slow network), the answer belongs to the old account and is dropped:
 * it must reach neither the new account's on-screen cache nor its on-device copy.
 */

/** Keeps the inbox cache, the single-conversation cache and the on-device copy in step with a
 *  conversation the server just returned (after a rename, a read mark, a mute ...). */
export async function applyConversation(
  summary: ConversationSummary,
  startedAt: number,
): Promise<void> {
  if (!sameSession(startedAt)) return;
  queryClient.setQueryData<ConversationSummary[]>(keys.conversations, (old) => {
    if (!old) return old;
    return old.some((c) => c.id === summary.id)
      ? old.map((c) => (c.id === summary.id ? summary : c))
      : [summary, ...old];
  });
  queryClient.setQueryData(keys.conversation(summary.id), summary);
  try {
    const store = await getLocalStore();
    // Checked again: opening the database is asynchronous too.
    if (sameSession(startedAt)) await store.upsertConversation(summary);
  } catch {
    // best effort
  }
}

export async function removeConversationLocally(id: string, startedAt: number): Promise<void> {
  if (!sameSession(startedAt)) return;
  queryClient.setQueryData<ConversationSummary[]>(keys.conversations, (old) =>
    old?.filter((c) => c.id !== id),
  );
  queryClient.removeQueries({ queryKey: keys.conversation(id) });
  queryClient.removeQueries({ queryKey: keys.messages(id) });
  try {
    const store = await getLocalStore();
    if (sameSession(startedAt)) await store.removeConversation(id);
  } catch {
    // best effort
  }
}

export async function startDirect(userId: string): Promise<ConversationSummary> {
  const startedAt = session.generation();
  const summary = await api.startDirectConversation(userId);
  await applyConversation(summary, startedAt);
  return summary;
}

export async function createGroup(
  title: string,
  memberIds: string[],
): Promise<ConversationSummary> {
  const startedAt = session.generation();
  const summary = await api.createGroupConversation({ title, memberIds });
  await applyConversation(summary, startedAt);
  return summary;
}

export async function renameGroup(id: string, title: string): Promise<void> {
  const startedAt = session.generation();
  await applyConversation(await api.renameConversation(id, title), startedAt);
}

export async function addGroupMembers(id: string, memberIds: string[]): Promise<void> {
  const startedAt = session.generation();
  await applyConversation(await api.addMembers(id, { memberIds }), startedAt);
  if (sameSession(startedAt)) await queryClient.invalidateQueries({ queryKey: keys.members(id) });
}

export async function removeGroupMember(id: string, userId: string): Promise<void> {
  const startedAt = session.generation();
  await api.removeMember(id, userId);
  if (sameSession(startedAt)) await queryClient.invalidateQueries({ queryKey: keys.members(id) });
}

export async function leaveGroup(id: string): Promise<void> {
  const startedAt = session.generation();
  await api.leaveConversation(id);
  await removeConversationLocally(id, startedAt);
}

export async function setMuted(id: string, muted: boolean): Promise<void> {
  const startedAt = session.generation();
  await applyConversation(await api.setConversationMuted(id, muted), startedAt);
}

export async function markRead(id: string, seq: number): Promise<void> {
  const startedAt = session.generation();
  await applyConversation(await api.markConversationRead(id, seq), startedAt);
}

export async function markUnread(id: string): Promise<void> {
  const startedAt = session.generation();
  await applyConversation(await api.markConversationUnread(id), startedAt);
}

export async function editMessageText(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<void> {
  const startedAt = session.generation();
  await recordMessage(await api.editMessage(conversationId, messageId, body), startedAt);
}

export async function deleteMessageForEveryone(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const startedAt = session.generation();
  await recordMessage(await api.deleteMessage(conversationId, messageId), startedAt);
}

export async function react(
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<MessageReactions> {
  const startedAt = session.generation();
  const result = await api.toggleReaction(conversationId, messageId, emoji);
  if (!sameSession(startedAt)) return result;
  const key = keys.messages(conversationId);
  queryClient.setQueryData<MessagesState>(key, (old) =>
    setReactions(old, messageId, result.reactions),
  );
  const updated = queryClient
    .getQueryData<MessagesState>(key)
    ?.messages.find((m) => m.id === messageId);
  if (updated) await recordMessage(updated, startedAt);
  return result;
}

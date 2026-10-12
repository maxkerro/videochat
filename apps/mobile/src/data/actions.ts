import type { ConversationSummary, MessageReactions } from '@videochat/shared';
import { getLocalStore } from '../db/expoDb';
import { session } from '../lib/api';
import * as api from './api';
import { keys } from './keys';
import { setReactions, type MessagesState } from './messagesState';
import { queryClient, sameSession } from './queryClient';
import { recordMessage } from './outboxRunner';

/** Keeps the inbox cache, the single-conversation cache and the on-device copy in step with a
 *  conversation the server just returned (after a rename, a read mark, a mute ...). */
export async function applyConversation(summary: ConversationSummary): Promise<void> {
  const startedAt = session.generation();
  queryClient.setQueryData<ConversationSummary[]>(keys.conversations, (old) => {
    if (!old) return old;
    return old.some((c) => c.id === summary.id)
      ? old.map((c) => (c.id === summary.id ? summary : c))
      : [summary, ...old];
  });
  queryClient.setQueryData(keys.conversation(summary.id), summary);
  if (!sameSession(startedAt)) return;
  try {
    await (await getLocalStore()).upsertConversation(summary);
  } catch {
    // best effort
  }
}

export async function removeConversationLocally(id: string): Promise<void> {
  queryClient.setQueryData<ConversationSummary[]>(keys.conversations, (old) =>
    old?.filter((c) => c.id !== id),
  );
  queryClient.removeQueries({ queryKey: keys.conversation(id) });
  queryClient.removeQueries({ queryKey: keys.messages(id) });
  try {
    await (await getLocalStore()).removeConversation(id);
  } catch {
    // best effort
  }
}

export async function startDirect(userId: string): Promise<ConversationSummary> {
  const summary = await api.startDirectConversation(userId);
  await applyConversation(summary);
  return summary;
}

export async function createGroup(
  title: string,
  memberIds: string[],
): Promise<ConversationSummary> {
  const summary = await api.createGroupConversation({ title, memberIds });
  await applyConversation(summary);
  return summary;
}

export async function renameGroup(id: string, title: string): Promise<void> {
  await applyConversation(await api.renameConversation(id, title));
}

export async function addGroupMembers(id: string, memberIds: string[]): Promise<void> {
  await applyConversation(await api.addMembers(id, { memberIds }));
  await queryClient.invalidateQueries({ queryKey: keys.members(id) });
}

export async function removeGroupMember(id: string, userId: string): Promise<void> {
  await api.removeMember(id, userId);
  await queryClient.invalidateQueries({ queryKey: keys.members(id) });
}

export async function leaveGroup(id: string): Promise<void> {
  await api.leaveConversation(id);
  await removeConversationLocally(id);
}

export async function setMuted(id: string, muted: boolean): Promise<void> {
  await applyConversation(await api.setConversationMuted(id, muted));
}

export async function markRead(id: string, seq: number): Promise<void> {
  await applyConversation(await api.markConversationRead(id, seq));
}

export async function markUnread(id: string): Promise<void> {
  await applyConversation(await api.markConversationUnread(id));
}

export async function editMessageText(
  conversationId: string,
  messageId: string,
  body: string,
): Promise<void> {
  await recordMessage(await api.editMessage(conversationId, messageId, body));
}

export async function deleteMessageForEveryone(
  conversationId: string,
  messageId: string,
): Promise<void> {
  await recordMessage(await api.deleteMessage(conversationId, messageId));
}

export async function react(
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<MessageReactions> {
  const result = await api.toggleReaction(conversationId, messageId, emoji);
  const key = keys.messages(conversationId);
  queryClient.setQueryData<MessagesState>(key, (old) =>
    setReactions(old, messageId, result.reactions),
  );
  const updated = queryClient
    .getQueryData<MessagesState>(key)
    ?.messages.find((m) => m.id === messageId);
  if (updated) await recordMessage(updated);
  return result;
}

import type { MessagesState } from './messagesState';

/**
 * CHAT-072: loads older pages until a message is in the conversation's loaded history (a search
 * result can be far back), or the history runs out. `loadOlder` loads one page and returns false
 * when it couldn't (offline, already at the start). Resolves whether the message is now loaded.
 */
export async function loadUntilLoaded(
  messageId: string,
  current: () => MessagesState | undefined,
  loadOlder: () => Promise<boolean>,
  maxPages = 100,
): Promise<boolean> {
  const isLoaded = () => current()?.messages.some((m) => m.id === messageId) ?? false;
  for (let i = 0; i < maxPages && !isLoaded(); i++) {
    if (!current()?.hasMore) break;
    if (!(await loadOlder())) break;
  }
  return isLoaded();
}

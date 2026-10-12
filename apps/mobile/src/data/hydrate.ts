import type { ConversationSummary } from '@videochat/shared';
import type { LocalStore } from '../db/store';

/**
 * CHAT-053: gets the on-device database ready for `userId`. A cache that belongs to anyone else
 * (or to nobody we can identify) is wiped and claimed; the account's own cache is returned so the
 * inbox can render from it before the network answers.
 */
export async function prepareStoreForUser(
  store: LocalStore,
  userId: string,
): Promise<ConversationSummary[]> {
  if ((await store.getOwner()) !== userId) {
    await store.wipe();
    await store.setOwner(userId);
    return [];
  }
  return store.loadConversations();
}

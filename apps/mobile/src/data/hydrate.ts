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
  /** False once the session this was started for has ended; checked before every write, so a slow
   *  start for a previous account can't claim the database after the next account has. */
  isCurrent: () => boolean = () => true,
): Promise<ConversationSummary[]> {
  const owner = await store.getOwner();
  if (!isCurrent()) return [];
  if (owner !== userId) {
    await store.wipe();
    if (!isCurrent()) return []; // the next account's own start will wipe and claim it
    await store.setOwner(userId);
    return [];
  }
  const cached = await store.loadConversations();
  return isCurrent() ? cached : [];
}

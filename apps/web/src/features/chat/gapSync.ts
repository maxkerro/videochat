import type { Message, MessagePage } from '@videochat/shared';

export interface GapSyncDeps {
  /** Every conversation this tab has a last-seen bookmark for. */
  trackedConversationIds: () => string[];
  getLastSeenSeq: (conversationId: string) => number | null;
  recordSeenSeq: (conversationId: string, seq: number) => void;
  fetchAfter: (conversationId: string, afterSeq: number) => Promise<MessagePage>;
  /** Called once per conversation with every message the sync fetched for it, oldest first --
   *  empty if there was nothing missed. Never called at all for a conversation with no bookmark
   *  yet (nothing to catch up on: it's never been opened in this tab). */
  onCaughtUp: (conversationId: string, messages: Message[]) => void;
}

/** Hard ceiling on gap-sync round trips per conversation per reconnect, independent of the
 *  server's own `messageGapSyncPageSize`. A person who was offline for months in an extremely
 *  busy group still gets *something* rather than the client looping forever on `hasMore: true` --
 *  they can page the rest via normal history scroll (CHAT-016) instead. */
const MAX_PAGES_PER_CONVERSATION = 25;

/**
 * CHAT-017: after a reconnect, ask the server for everything each tracked conversation missed
 * since its last-seen `seq`, in order, and hand the results to `onCaughtUp` so the caller can
 * merge them into the UI exactly like a live `message.new` event. Conversations are synced
 * independently -- one failing (e.g. the person left it, now a 404) doesn't stop the others.
 */
export async function runGapSync(deps: GapSyncDeps): Promise<void> {
  const ids = deps.trackedConversationIds();
  await Promise.all(ids.map((id) => syncOne(id, deps)));
}

async function syncOne(conversationId: string, deps: GapSyncDeps): Promise<void> {
  let afterSeq = deps.getLastSeenSeq(conversationId);
  if (afterSeq === null) return; // Never opened in this tab: nothing to catch up on.

  const collected: Message[] = [];
  try {
    for (let page = 0; page < MAX_PAGES_PER_CONVERSATION; page += 1) {
      const result = await deps.fetchAfter(conversationId, afterSeq);
      collected.push(...result.messages);
      const last = result.messages.at(-1);
      if (last) {
        afterSeq = last.seq;
        deps.recordSeenSeq(conversationId, last.seq);
      }
      if (!result.hasMore) break;
    }
  } catch {
    // A conversation the person can no longer read (404, e.g. removed while offline), or a
    // transient network error -- either way, report whatever was collected before the failure and
    // let the next reconnect try again rather than losing everything gathered so far.
  }
  if (collected.length > 0) deps.onCaughtUp(conversationId, collected);
}

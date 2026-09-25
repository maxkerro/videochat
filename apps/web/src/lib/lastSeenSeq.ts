const STORAGE_PREFIX = 'videochat:lastSeenSeq:';

/** localStorage key listing every conversation id this tab has ever tracked a `seq` for -- kept
 *  as its own entry (rather than scanning `localStorage` for prefixed keys, which some browsers'
 *  privacy modes restrict) so {@link trackedConversationIds} is a single, cheap read. */
const INDEX_KEY = 'videochat:lastSeenSeq:index';

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing in some browsers throws on any localStorage access. Gap sync degrades to
    // "nothing tracked yet" rather than crashing the app.
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage disabled -- losing the last-seen bookmark just means the next
    // reconnect re-fetches a bit more than strictly necessary, never a correctness problem.
  }
}

/**
 * CHAT-017: the highest message `seq` this tab has seen for a conversation, persisted across
 * reloads so the app can ask the server "what did I miss after this?" on reconnect. Deliberately
 * monotonic -- {@link recordSeenSeq} never moves it backwards, so an out-of-order or duplicate
 * event can't rewind the bookmark and cause the next gap sync to re-fetch (and re-render) messages
 * already shown.
 */
export function getLastSeenSeq(conversationId: string): number | null {
  const raw = safeGetItem(STORAGE_PREFIX + conversationId);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Records the highest `seq` seen so far for a conversation, ignoring a `seq` that isn't actually
 *  newer than what's already stored. Also adds the conversation to the tracked-ids index the
 *  first time it's seen. */
export function recordSeenSeq(conversationId: string, seq: number): void {
  const current = getLastSeenSeq(conversationId);
  if (current !== null && seq <= current) return;
  safeSetItem(STORAGE_PREFIX + conversationId, String(seq));
  const ids = trackedConversationIds();
  if (!ids.includes(conversationId)) {
    safeSetItem(INDEX_KEY, JSON.stringify([...ids, conversationId]));
  }
}

/** Every conversation id this tab has ever recorded a seq for -- the set gap sync walks after a
 *  reconnect. */
export function trackedConversationIds(): string[] {
  const raw = safeGetItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

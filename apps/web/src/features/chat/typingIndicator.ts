import type { TypingEvent } from '@videochat/shared';

/** One currently-typing member: their display name (embedded in the event itself -- see
 *  `typingEventSchema`'s comment on why, there's no persisted row to join against) and when we
 *  last heard from them, for local expiry. */
export interface TypingEntry {
  displayName: string;
  lastSeenAt: number;
}

/**
 * Local-only expiry (AC: "'Anna is typing…' ... disappears within 6s after she stops"). The
 * server tracks no typing state of its own -- see `typingEventSchema`'s comment -- so each client
 * decides for itself when a typer has gone quiet. The sender refreshes at most once per 3s while
 * still typing (`TypingThrottle`), so 5s comfortably survives one delayed/missed refresh with
 * margin while still landing inside the 6s "disappears within" ceiling.
 */
export const TYPING_EXPIRY_MS = 5_000;

/** Adds or refreshes one typer's entry. Returns a new `Map` rather than mutating `entries`, so
 *  it's safe to pass straight to a React state setter. */
export function withTypingEvent(
  entries: ReadonlyMap<string, TypingEntry>,
  event: Pick<TypingEvent, 'userId' | 'displayName'>,
  now: number,
): Map<string, TypingEntry> {
  const next = new Map(entries);
  next.set(event.userId, { displayName: event.displayName, lastSeenAt: now });
  return next;
}

/** Drops any entry not refreshed within {@link TYPING_EXPIRY_MS} of `now`. Returns the exact same
 *  `Map` instance when nothing expired, so a caller (e.g. a polling interval) can skip a state
 *  update -- and the re-render it would cause -- when pruning was a no-op. */
export function pruneExpiredTyping(
  entries: ReadonlyMap<string, TypingEntry>,
  now: number,
): ReadonlyMap<string, TypingEntry> {
  let changed = false;
  const next = new Map(entries);
  for (const [userId, entry] of entries) {
    if (now - entry.lastSeenAt >= TYPING_EXPIRY_MS) {
      next.delete(userId);
      changed = true;
    }
  }
  return changed ? next : entries;
}

/**
 * AC: "In groups up to 3 names are shown, then 'Several people are typing'".
 *
 * Interpretation (the AC text is slightly ambiguous about whether *exactly* 3 concurrent typers
 * are still named or already collapse): 1, 2 or 3 typers are named -- "up to 3 names" read
 * literally -- joined the way a natural sentence would ("Anna is typing…", "Anna and Ben are
 * typing…", "Anna, Ben and Cara are typing…"); 4 or more collapses to the generic "Several people
 * are typing…" rather than an ever-growing name list. `displayNames` order is caller-controlled
 * (e.g. by who started typing first) -- this only joins them.
 */
export function formatTypingLabel(displayNames: readonly string[]): string | null {
  if (displayNames.length === 0) return null;
  if (displayNames.length === 1) return `${displayNames[0]} is typing…`;
  if (displayNames.length > 3) return 'Several people are typing…';
  const last = displayNames.at(-1);
  const rest = displayNames.slice(0, -1);
  return `${rest.join(', ')} and ${last} are typing…`;
}

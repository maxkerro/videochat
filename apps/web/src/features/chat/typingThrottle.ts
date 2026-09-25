/**
 * CHAT-020: leading-edge throttle for sending "I'm typing" -- at most one send per conversation
 * per {@link TypingThrottle.constructor}'s `intervalMs` (default 3000ms), matching the AC's
 * "throttled to one per 3s per user".
 *
 * Leading edge, unlike {@link ReadReceiptThrottle}'s trailing edge: the *first* keystroke should
 * announce typing right away (AC: "'Anna is typing…' appears within 1s"), and there's no value in
 * queuing a trailing send for later the way a read receipt's "report the highest seq eventually"
 * needs to -- a typing signal that's still true a few seconds from now will get its own fresh
 * signal from the next keystroke past the cooldown anyway. Keyed per-conversation so switching
 * between two conversations doesn't make one wait on the other's throttle.
 */
export class TypingThrottle {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly send: (conversationId: string) => void,
    private readonly intervalMs = 3000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Called on every keystroke while the composer holds non-empty text. Sends immediately the
   *  first time for a conversation, or once `intervalMs` has elapsed since the last send;
   *  otherwise a no-op. There's deliberately no queued/trailing send here (contrast
   *  `ReadReceiptThrottle.request`): if typing continues past the cooldown, the very next
   *  keystroke triggers a fresh send on its own. */
  notifyTyping(conversationId: string): void {
    const now = this.now();
    const last = this.lastSentAt.get(conversationId);
    if (last !== undefined && now - last < this.intervalMs) return;
    this.lastSentAt.set(conversationId, now);
    this.send(conversationId);
  }

  /** Drops a conversation's cooldown -- e.g. useful when leaving it, so a much later return visit
   *  isn't held back by a stale timestamp from long ago. Not required by the AC, but cheap. */
  reset(conversationId: string): void {
    this.lastSentAt.delete(conversationId);
  }
}

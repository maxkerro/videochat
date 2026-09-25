/**
 * CHAT-019: trailing-edge throttle for sending "mark read up to `seq`" -- at most one send per
 * conversation per {@link ReadReceiptThrottle.constructor}'s `intervalMs` (default 1000ms),
 * matching the "read updates are batched (at most one per second per conversation)" AC. Keyed
 * per-conversation (not a single global cooldown) so reading two open conversations in quick
 * succession doesn't make one wait on the other's throttle.
 *
 * Only ever sends the *highest* `seq` requested since the last send for that conversation -- a
 * lower `seq` requested after a higher one (e.g. the person scrolled up briefly, or two calls
 * landed in the same tick) is coalesced away rather than queued, since the server's own
 * `lastReadSeq` update is a `GREATEST` (never moves backward) and sending a lower value after a
 * higher one already went out would just be a wasted round trip.
 */
export class ReadReceiptThrottle {
  /** Highest `seq` actually sent so far, per conversation -- the floor a new request must clear.
   *  Kept separate from `pendingSeq` so `cancel` (which only drops what's *queued*) can never
   *  un-send something that already went out. */
  private readonly sentSeq = new Map<string, number>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly pendingSeq = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly send: (conversationId: string, seq: number) => void,
    private readonly intervalMs = 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Requests that `seq` eventually be reported as read for `conversationId`. May send
   *  immediately (if the interval has already elapsed since the last send for this conversation)
   *  or schedule a trailing send for whenever it next elapses. A `seq` no higher than one already
   *  sent or already queued is a no-op -- sending it would tell the server nothing new. */
  request(conversationId: string, seq: number): void {
    const known = Math.max(
      this.sentSeq.get(conversationId) ?? 0,
      this.pendingSeq.get(conversationId) ?? 0,
    );
    if (seq <= known) return;
    this.pendingSeq.set(conversationId, seq);

    if (this.timers.has(conversationId)) return; // A send is already scheduled; it'll pick this up.

    const elapsed = this.now() - (this.lastSentAt.get(conversationId) ?? -Infinity);
    const delay = Math.max(0, this.intervalMs - elapsed);
    const timer = setTimeout(() => this.flush(conversationId), delay);
    this.timers.set(conversationId, timer);
  }

  private flush(conversationId: string): void {
    this.timers.delete(conversationId);
    const seq = this.pendingSeq.get(conversationId);
    if (seq === undefined) return;
    this.pendingSeq.delete(conversationId);
    this.sentSeq.set(conversationId, seq);
    this.lastSentAt.set(conversationId, this.now());
    this.send(conversationId, seq);
  }

  /** Drops any pending (not-yet-sent) request for a conversation without sending it -- used when
   *  the tab goes hidden (AC: "receipts are not sent while the tab is hidden") or the conversation
   *  is no longer open. Does not reset the "last sent" cooldown -- a still-open conversation that
   *  becomes visible again shortly after should still wait out the rest of the interval, not fire
   *  immediately just because its pending request was cancelled. Never un-sends anything already
   *  sent: a later request lower than that still won't go out (see `request`'s `sentSeq` floor). */
  cancel(conversationId: string): void {
    const timer = this.timers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.timers.delete(conversationId);
    this.pendingSeq.delete(conversationId);
  }
}

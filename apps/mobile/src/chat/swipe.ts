/** CHAT-057: how far a bubble has to be dragged right for a release to count as "reply". */
export const SWIPE_REPLY_THRESHOLD = 64;
/** The bubble stops following the finger here (it is a nudge, not a drag-away). */
export const SWIPE_MAX_TRAVEL = 88;
/** Movement before we decide whether it is a swipe or a scroll. */
export const SWIPE_START_SLOP = 10;

/** A swipe, not a scroll: mostly sideways, and to the right (the list scrolls vertically). */
export function isReplySwipe(dx: number, dy: number): boolean {
  return dx > SWIPE_START_SLOP && dx > Math.abs(dy) * 2;
}

/** Where the bubble sits for a finger that has moved `dx`: follows it, with growing resistance. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_REPLY_THRESHOLD) return dx;
  const extra = dx - SWIPE_REPLY_THRESHOLD;
  return Math.min(SWIPE_MAX_TRAVEL, SWIPE_REPLY_THRESHOLD + extra * 0.3);
}

export function reachedThreshold(dx: number): boolean {
  return dx >= SWIPE_REPLY_THRESHOLD;
}

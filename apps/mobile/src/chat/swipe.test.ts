import { describe, expect, it } from 'vitest';
import {
  SWIPE_MAX_TRAVEL,
  SWIPE_REPLY_THRESHOLD,
  isReplySwipe,
  reachedThreshold,
  swipeOffset,
} from './swipe';

describe('swipe to reply', () => {
  it('only a mostly-horizontal move to the right starts a swipe', () => {
    expect(isReplySwipe(30, 4)).toBe(true);
    expect(isReplySwipe(30, 20)).toBe(false); // a diagonal scroll
    expect(isReplySwipe(5, 0)).toBe(false); // not enough movement yet
    expect(isReplySwipe(-40, 2)).toBe(false); // leftwards
  });

  it('the bubble follows the finger, then resists, then stops', () => {
    expect(swipeOffset(-20)).toBe(0);
    expect(swipeOffset(30)).toBe(30);
    expect(swipeOffset(SWIPE_REPLY_THRESHOLD)).toBe(SWIPE_REPLY_THRESHOLD);
    expect(swipeOffset(SWIPE_REPLY_THRESHOLD + 20)).toBeCloseTo(SWIPE_REPLY_THRESHOLD + 6);
    expect(swipeOffset(1000)).toBe(SWIPE_MAX_TRAVEL);
  });

  it('a release counts as a reply from the threshold on', () => {
    expect(reachedThreshold(SWIPE_REPLY_THRESHOLD - 1)).toBe(false);
    expect(reachedThreshold(SWIPE_REPLY_THRESHOLD)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { routeForNotification, totalUnread } from './payload';

const ID = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';

describe('routeForNotification', () => {
  it('opens the conversation named in the notification', () => {
    expect(routeForNotification({ conversationId: ID, url: '/c/x' })).toBe(`/c/${ID}`);
  });
  it('ignores anything that is not a conversation id', () => {
    expect(routeForNotification({ conversationId: '../../settings' })).toBeNull();
    expect(routeForNotification({ url: '/c/abc' })).toBeNull();
    expect(routeForNotification(null)).toBeNull();
    expect(routeForNotification('x')).toBeNull();
  });
});

describe('totalUnread', () => {
  it('sums unread messages and skips muted conversations', () => {
    expect(
      totalUnread([
        { lastSeq: 10, lastReadSeq: 7, muted: false },
        { lastSeq: 5, lastReadSeq: 5, muted: false },
        { lastSeq: 9, lastReadSeq: 0, muted: true },
        { lastSeq: 2, lastReadSeq: 4, muted: false },
      ]),
    ).toBe(3);
  });
});

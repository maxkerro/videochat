import type { ConversationSummary } from '@videochat/shared';
import { titleFor, totalUnread } from './unreadBadge';

const conv = (lastSeq: number, lastReadSeq: number, muted = false) =>
  ({ lastSeq, lastReadSeq, muted }) as ConversationSummary;

describe('unread badge (CHAT-035)', () => {
  it('counts unread messages, leaving muted conversations out', () => {
    expect(totalUnread([conv(5, 2), conv(3, 3), conv(10, 0, true)])).toBe(3);
  });

  it('puts the count in the tab title, capped at 99+', () => {
    expect(titleFor(0)).toBe('Videochat');
    expect(titleFor(4)).toBe('(4) Videochat');
    expect(titleFor(250)).toBe('(99+) Videochat');
  });
});

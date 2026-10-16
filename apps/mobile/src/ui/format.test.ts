import type { ConversationSummary, Message } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import {
  callLabel,
  canDeleteMessage,
  canEditMessage,
  conversationTitle,
  formatBytes,
  formatDayHeading,
  formatListTime,
  lastMessagePreview,
  unreadCount,
} from './format';

const ME = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
const PEER = '9a1c0c7e-2b2c-4d5a-9f55-0d3b8f1a2b3d';

const conv = (extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e',
  type: 'direct',
  title: null,
  lastSeq: 5,
  lastMessageAt: null,
  role: 'member',
  lastReadSeq: 2,
  peer: { id: PEER, username: 'anna', displayName: 'Anna', avatarUrl: null },
  peerLastReadSeq: null,
  muted: false,
  unreadMentions: 0,
  lastMessage: null,
  ...extra,
});

const msg = (extra: Partial<Message> = {}): Message => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5F01',
  conversationId: conv().id,
  seq: 1,
  senderId: ME,
  clientMsgId: null,
  type: 'text',
  body: 'hi',
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-10-06T10:00:00.000Z',
  ...extra,
});

describe('format', () => {
  it('titles: a direct chat is the peer, a group is its title', () => {
    expect(conversationTitle(conv())).toBe('Anna');
    expect(conversationTitle(conv({ type: 'group', title: 'Team', peer: null }))).toBe('Team');
    expect(conversationTitle(conv({ type: 'group', title: null, peer: null }))).toBe('Group');
  });

  it('counts unread messages and never goes negative', () => {
    expect(unreadCount(conv())).toBe(3);
    expect(unreadCount(conv({ lastReadSeq: 9 }))).toBe(0);
  });

  it('previews: text, own prefix, photo, file, deleted, call, empty', () => {
    const base = { type: 'text', senderId: PEER, body: 'hello\nworld' } as const;
    expect(lastMessagePreview(conv({ lastMessage: base }), ME)).toBe('hello world');
    // CHAT-076 (spike)
    expect(
      lastMessagePreview(conv({ lastMessage: { ...base, body: null, encrypted: true } }), ME),
    ).toBe('🔒 Encrypted message');
    expect(lastMessagePreview(conv({ lastMessage: { ...base, senderId: ME } }), ME)).toBe(
      'You: hello world',
    );
    const att = (kind: 'image' | 'file') => ({
      type: kind === 'image' ? ('image' as const) : ('file' as const),
      senderId: PEER,
      body: null,
      attachment: { kind, filename: 'a.pdf' },
    });
    expect(lastMessagePreview(conv({ lastMessage: att('image') }), ME)).toBe('Photo');
    expect(lastMessagePreview(conv({ lastMessage: att('file') }), ME)).toBe('a.pdf');
    expect(
      lastMessagePreview(conv({ lastMessage: { type: 'text', senderId: PEER, body: null } }), ME),
    ).toBe('Message deleted');
    expect(
      lastMessagePreview(conv({ lastMessage: { type: 'call', senderId: PEER, body: null } }), ME),
    ).toBe('Call');
    expect(lastMessagePreview(conv(), ME)).toBe('No messages yet');
  });

  it('list time: clock today, weekday this week, date otherwise', () => {
    const now = new Date(2026, 9, 6, 15, 0); // Tue 6 Oct 2026, local
    expect(formatListTime(new Date(2026, 9, 6, 9, 5).toISOString(), now)).toBe('09:05');
    expect(formatListTime(new Date(2026, 9, 3, 9, 5).toISOString(), now)).toBe('Sat');
    expect(formatListTime(new Date(2026, 8, 20, 9, 5).toISOString(), now)).toBe('20.9.');
    expect(formatListTime(null, now)).toBe('');
    expect(formatListTime('garbage', now)).toBe('');
  });

  it('day headings', () => {
    const now = new Date(2026, 9, 6, 15, 0);
    expect(formatDayHeading(new Date(2026, 9, 6, 1).toISOString(), now)).toBe('Today');
    expect(formatDayHeading(new Date(2026, 9, 5, 23).toISOString(), now)).toBe('Yesterday');
    expect(formatDayHeading(new Date(2026, 8, 1).toISOString(), now)).toBe('1.9.2026');
  });

  it('edit window and delete rights', () => {
    const now = new Date('2026-10-06T10:10:00.000Z').getTime();
    expect(canEditMessage(msg(), ME, now)).toBe(true);
    expect(canEditMessage(msg(), PEER, now)).toBe(false);
    expect(canEditMessage(msg(), ME, now + 10 * 60_000)).toBe(false); // past 15 min
    expect(canEditMessage(msg({ deletedAt: '2026-10-06T10:01:00.000Z' }), ME, now)).toBe(false);
    expect(canDeleteMessage(msg(), ME)).toBe(true);
    expect(canDeleteMessage(msg({ type: 'call' }), ME)).toBe(false);
    expect(canDeleteMessage(msg(), PEER)).toBe(false);
  });

  it('call wording depends on who is looking', () => {
    const call = (outcome: 'missed' | 'declined' | 'completed', callerId: string) =>
      msg({
        type: 'call',
        call: {
          callId: '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e',
          media: 'video',
          outcome,
          endReason: 'missed',
          callerId,
          durationSec: 75,
        },
      });
    expect(callLabel(call('missed', PEER), ME)).toBe('Missed video call');
    expect(callLabel(call('missed', ME), ME)).toBe('No answer');
    expect(callLabel(call('completed', ME), ME)).toBe('Outgoing video call · 1 min 15 s');
  });

  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

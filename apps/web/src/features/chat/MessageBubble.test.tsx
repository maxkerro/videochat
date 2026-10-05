import type { Message } from '@videochat/shared';
import { canDeleteMessage, canEditMessage, replyQuoteText } from './MessageBubble';

const me = '11111111-1111-4111-8111-111111111111';

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    conversationId: '33333333-3333-4333-8333-333333333333',
    seq: 1,
    senderId: me,
    clientMsgId: null,
    type: 'text',
    body: 'hi',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('message permissions (CHAT-032)', () => {
  it('lets the sender edit for 15 minutes only', () => {
    expect(canEditMessage(msg(), me)).toBe(true);
    const old = msg({ createdAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    expect(canEditMessage(old, me)).toBe(false);
    expect(canEditMessage(msg({ senderId: 'other' }), me)).toBe(false);
    expect(canEditMessage(msg({ type: 'call' }), me)).toBe(false);
  });

  it('lets the sender or a group admin delete, never call entries or tombstones', () => {
    expect(canDeleteMessage(msg(), me, false)).toBe(true);
    expect(canDeleteMessage(msg({ senderId: 'other' }), me, false)).toBe(false);
    expect(canDeleteMessage(msg({ senderId: 'other' }), me, true)).toBe(true);
    expect(canDeleteMessage(msg({ type: 'call' }), me, true)).toBe(false);
    expect(canDeleteMessage(msg({ deletedAt: new Date().toISOString() }), me, true)).toBe(false);
  });
});

describe('replyQuoteText', () => {
  const base = {
    id: 'x'.repeat(26),
    seq: 1,
    senderId: null,
    type: 'text' as const,
    deleted: false,
  };
  it('describes the original', () => {
    expect(replyQuoteText({ ...base, snippet: 'Lunch?' })).toBe('Lunch?');
    expect(replyQuoteText({ ...base, snippet: null, deleted: true })).toBe(
      'Original message deleted',
    );
    expect(
      replyQuoteText({ ...base, snippet: null, attachment: { kind: 'image', filename: 'a.jpg' } }),
    ).toBe('Photo');
    expect(
      replyQuoteText({ ...base, snippet: null, attachment: { kind: 'file', filename: 'q3.pdf' } }),
    ).toBe('q3.pdf');
  });
});

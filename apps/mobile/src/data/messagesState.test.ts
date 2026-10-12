import type { Message } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import { mergeLatestPage, mergeMessages, prependOlder, setReactions } from './messagesState';

const msg = (seq: number, body = `m${seq}`): Message => ({
  id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, '0')}`,
  conversationId: '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c',
  seq,
  senderId: null,
  clientMsgId: null,
  type: 'text',
  body,
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const seqs = (s: { messages: Message[] } | undefined) => s?.messages.map((m) => m.seq);

describe('messagesState', () => {
  it('merges new messages in seq order and replaces edited ones by id', () => {
    const state = { messages: [msg(1), msg(3)], hasMore: true };
    const next = mergeMessages(state, [msg(2), msg(3, 'edited')]);
    expect(seqs(next)).toEqual([1, 2, 3]);
    expect(next.messages[2]!.body).toBe('edited');
    expect(next.hasMore).toBe(true);
  });

  it('a latest page keeps older history that is already loaded', () => {
    const state = { messages: [msg(1), msg(2), msg(3), msg(4)], hasMore: true };
    const next = mergeLatestPage(state, { messages: [msg(3, 'x'), msg(4), msg(5)], hasMore: true });
    expect(seqs(next)).toEqual([1, 2, 3, 4, 5]);
    expect(next.messages[2]!.body).toBe('x');
    expect(next.hasMore).toBe(true);
  });

  it('drops cached history that does not join the latest page (a hole in the middle)', () => {
    const state = { messages: [msg(1), msg(2)], hasMore: true };
    const next = mergeLatestPage(state, { messages: [msg(10), msg(11)], hasMore: true });
    expect(seqs(next)).toEqual([10, 11]);
  });

  it('a latest page into an empty state takes the page and its hasMore', () => {
    const next = mergeLatestPage(undefined, { messages: [msg(8), msg(9)], hasMore: true });
    expect(seqs(next)).toEqual([8, 9]);
    expect(next.hasMore).toBe(true);
    expect(mergeLatestPage(undefined, { messages: [], hasMore: false })).toEqual({
      messages: [],
      hasMore: false,
    });
  });

  it('prepends an older page and takes its hasMore', () => {
    const next = prependOlder(
      { messages: [msg(3), msg(4)], hasMore: true },
      { messages: [msg(1), msg(2)], hasMore: false },
    );
    expect(seqs(next)).toEqual([1, 2, 3, 4]);
    expect(next.hasMore).toBe(false);
  });

  it('sets and clears reactions on one message', () => {
    const state = { messages: [msg(1), msg(2)], hasMore: false };
    const r = [{ emoji: '👍', count: 1, userIds: ['3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c'] }];
    const withReaction = setReactions(state, state.messages[0]!.id, r);
    expect(withReaction?.messages[0]!.reactions).toEqual(r);
    expect(setReactions(withReaction, state.messages[0]!.id, [])?.messages[0]).not.toHaveProperty(
      'reactions',
    );
    expect(setReactions(state, 'unknown', r)).toBe(state);
  });
});

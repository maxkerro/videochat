import type { Message } from '@videochat/shared';
import { replaceMessage, setMessageReactions, type MessagesData } from './messagesCache';

function msg(id: string, body: string): Message {
  return {
    id,
    conversationId: '33333333-3333-4333-8333-333333333333',
    seq: 1,
    senderId: null,
    clientMsgId: null,
    type: 'text',
    body,
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('replaceMessage', () => {
  const data: MessagesData = {
    pages: [
      { messages: [msg('A'.repeat(26), 'old')], hasMore: false },
      { messages: [msg('B'.repeat(26), 'newer')], hasMore: false },
    ],
    pageParams: [undefined, undefined],
  };

  it('swaps the message in whichever page holds it', () => {
    const next = replaceMessage(data, msg('A'.repeat(26), 'edited'))!;
    expect(next.pages[0]!.messages[0]!.body).toBe('edited');
    expect(next.pages[1]).toBe(data.pages[1]);
  });

  it('leaves the cache untouched for a message that is not loaded', () => {
    expect(replaceMessage(data, msg('C'.repeat(26), 'x'))).toBe(data);
    expect(replaceMessage(undefined, msg('C'.repeat(26), 'x'))).toBeUndefined();
  });
});

describe('setMessageReactions', () => {
  const data: MessagesData = {
    pages: [{ messages: [msg('A'.repeat(26), 'x')], hasMore: false }],
    pageParams: [undefined],
  };
  it("sets and clears a message's reactions", () => {
    const r = [{ emoji: '👍', count: 1, userIds: ['11111111-1111-4111-8111-111111111111'] }];
    const withR = setMessageReactions(data, 'A'.repeat(26), r)!;
    expect(withR.pages[0]!.messages[0]!.reactions).toEqual(r);
    const cleared = setMessageReactions(withR, 'A'.repeat(26), [])!;
    expect(cleared.pages[0]!.messages[0]).not.toHaveProperty('reactions');
  });
});

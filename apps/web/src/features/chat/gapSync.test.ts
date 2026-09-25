import type { Message, MessagePage } from '@videochat/shared';
import { runGapSync } from './gapSync';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'A'.repeat(26),
    conversationId: 'conv-1',
    seq: 1,
    senderId: 'user-1',
    clientMsgId: null,
    type: 'text',
    body: 'hi',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('runGapSync', () => {
  it('does nothing for a conversation with no bookmark yet', async () => {
    const fetchAfter = vi.fn();
    const onCaughtUp = vi.fn();
    await runGapSync({
      trackedConversationIds: () => ['conv-1'],
      getLastSeenSeq: () => null,
      recordSeenSeq: vi.fn(),
      fetchAfter,
      onCaughtUp,
    });
    expect(fetchAfter).not.toHaveBeenCalled();
    expect(onCaughtUp).not.toHaveBeenCalled();
  });

  it('fetches once and reports the missed messages when hasMore is false', async () => {
    const missed = [makeMessage({ seq: 2 }), makeMessage({ seq: 3 })];
    const fetchAfter = vi.fn(async (): Promise<MessagePage> => ({
      messages: missed,
      hasMore: false,
    }));
    const recordSeenSeq = vi.fn();
    const onCaughtUp = vi.fn();

    await runGapSync({
      trackedConversationIds: () => ['conv-1'],
      getLastSeenSeq: () => 1,
      recordSeenSeq,
      fetchAfter,
      onCaughtUp,
    });

    expect(fetchAfter).toHaveBeenCalledTimes(1);
    expect(fetchAfter).toHaveBeenCalledWith('conv-1', 1);
    expect(recordSeenSeq).toHaveBeenLastCalledWith('conv-1', 3);
    expect(onCaughtUp).toHaveBeenCalledWith('conv-1', missed);
  });

  it('loops while hasMore is true, advancing the cursor each time', async () => {
    const fetchAfter = vi
      .fn()
      .mockResolvedValueOnce({ messages: [makeMessage({ seq: 2 })], hasMore: true })
      .mockResolvedValueOnce({ messages: [makeMessage({ seq: 3 })], hasMore: false });
    const onCaughtUp = vi.fn();

    await runGapSync({
      trackedConversationIds: () => ['conv-1'],
      getLastSeenSeq: () => 1,
      recordSeenSeq: vi.fn(),
      fetchAfter,
      onCaughtUp,
    });

    expect(fetchAfter).toHaveBeenNthCalledWith(1, 'conv-1', 1);
    expect(fetchAfter).toHaveBeenNthCalledWith(2, 'conv-1', 2);
    expect(onCaughtUp).toHaveBeenCalledTimes(1);
    expect(onCaughtUp.mock.calls[0]![1].map((m: Message) => m.seq)).toEqual([2, 3]);
  });

  it('syncs multiple conversations independently', async () => {
    const fetchAfter = vi.fn(async (conversationId: string): Promise<MessagePage> => ({
      messages: [makeMessage({ conversationId, seq: 5 })],
      hasMore: false,
    }));
    const onCaughtUp = vi.fn();

    await runGapSync({
      trackedConversationIds: () => ['conv-1', 'conv-2'],
      getLastSeenSeq: (id) => (id === 'conv-1' ? 1 : 4),
      recordSeenSeq: vi.fn(),
      fetchAfter,
      onCaughtUp,
    });

    expect(fetchAfter).toHaveBeenCalledWith('conv-1', 1);
    expect(fetchAfter).toHaveBeenCalledWith('conv-2', 4);
    expect(onCaughtUp).toHaveBeenCalledTimes(2);
  });

  it('reports whatever was collected before a mid-loop failure, without throwing', async () => {
    const fetchAfter = vi
      .fn()
      .mockResolvedValueOnce({ messages: [makeMessage({ seq: 2 })], hasMore: true })
      .mockRejectedValueOnce(new Error('network blip'));
    const onCaughtUp = vi.fn();

    await expect(
      runGapSync({
        trackedConversationIds: () => ['conv-1'],
        getLastSeenSeq: () => 1,
        recordSeenSeq: vi.fn(),
        fetchAfter,
        onCaughtUp,
      }),
    ).resolves.toBeUndefined();

    expect(onCaughtUp).toHaveBeenCalledTimes(1);
    expect(onCaughtUp.mock.calls[0]![1]).toHaveLength(1);
  });

  it('never calls onCaughtUp when a conversation has a bookmark but genuinely nothing missed', async () => {
    const fetchAfter = vi.fn(async (): Promise<MessagePage> => ({ messages: [], hasMore: false }));
    const onCaughtUp = vi.fn();

    await runGapSync({
      trackedConversationIds: () => ['conv-1'],
      getLastSeenSeq: () => 5,
      recordSeenSeq: vi.fn(),
      fetchAfter,
      onCaughtUp,
    });

    expect(onCaughtUp).not.toHaveBeenCalled();
  });
});

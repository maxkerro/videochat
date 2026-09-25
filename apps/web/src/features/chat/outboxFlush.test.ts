import type { Message } from '@videochat/shared';
import { ApiError } from '../../lib/api';
import type { OutboxMessage } from '../../lib/outbox';
import { flushOutbox } from './outboxFlush';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'A'.repeat(26),
    conversationId: 'conv-1',
    seq: 1,
    senderId: 'user-1',
    clientMsgId: 'c-1',
    type: 'text',
    body: 'hi',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function queued(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return { clientMsgId: 'c-1', conversationId: 'conv-1', body: 'hi', queuedAt: 1, ...overrides };
}

describe('flushOutbox', () => {
  it('does nothing when the outbox is empty', async () => {
    const send = vi.fn();
    await flushOutbox({ listQueued: async () => [], send, remove: vi.fn(), onSent: vi.fn() });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a queued message, removes it, and reports it sent', async () => {
    const message = makeMessage();
    const send = vi.fn(async () => message);
    const remove = vi.fn();
    const onSent = vi.fn();

    await flushOutbox({ listQueued: async () => [queued()], send, remove, onSent });

    expect(send).toHaveBeenCalledWith('conv-1', 'c-1', 'hi');
    expect(remove).toHaveBeenCalledWith('c-1');
    expect(onSent).toHaveBeenCalledWith(message);
  });

  it('sends multiple queued messages in order', async () => {
    const order: string[] = [];
    const send = vi.fn(async (conversationId: string, clientMsgId: string, body: string) => {
      order.push(clientMsgId);
      return makeMessage({ conversationId, clientMsgId, body });
    });

    await flushOutbox({
      listQueued: async () => [
        queued({ clientMsgId: 'c-1', queuedAt: 1 }),
        queued({ clientMsgId: 'c-2', queuedAt: 2 }),
        queued({ clientMsgId: 'c-3', queuedAt: 3 }),
      ],
      send,
      remove: vi.fn(),
      onSent: vi.fn(),
    });

    expect(order).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('stops at the first still-offline failure, leaving later messages queued', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(makeMessage({ clientMsgId: 'c-1' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const remove = vi.fn();

    await flushOutbox({
      listQueued: async () => [
        queued({ clientMsgId: 'c-1', queuedAt: 1 }),
        queued({ clientMsgId: 'c-2', queuedAt: 2 }),
        queued({ clientMsgId: 'c-3', queuedAt: 3 }),
      ],
      send,
      remove,
      onSent: vi.fn(),
    });

    expect(send).toHaveBeenCalledTimes(2); // c-1 succeeds, c-2 fails, c-3 never attempted.
    expect(remove).toHaveBeenCalledWith('c-1');
    expect(remove).not.toHaveBeenCalledWith('c-2');
    expect(remove).not.toHaveBeenCalledWith('c-3');
  });

  it('drops a message the server permanently rejected, and continues with the rest', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'clientMsgId already used in another conversation'))
      .mockResolvedValueOnce(makeMessage({ clientMsgId: 'c-2' }));
    const remove = vi.fn();
    const onSent = vi.fn();

    await flushOutbox({
      listQueued: async () => [
        queued({ clientMsgId: 'c-1', queuedAt: 1 }),
        queued({ clientMsgId: 'c-2', queuedAt: 2 }),
      ],
      send,
      remove,
      onSent,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('c-1'); // Dropped, not left stuck forever.
    expect(remove).toHaveBeenCalledWith('c-2');
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});

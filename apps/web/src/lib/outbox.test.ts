import {
  enqueueOutboxMessage,
  listAllQueuedMessages,
  listQueuedMessages,
  removeOutboxMessage,
} from './outbox';

describe('outbox', () => {
  it('starts empty', async () => {
    expect(await listQueuedMessages('conv-1')).toEqual([]);
    expect(await listAllQueuedMessages()).toEqual([]);
  });

  it('enqueues and lists a message for its own conversation only', async () => {
    await enqueueOutboxMessage({
      clientMsgId: 'c-1',
      conversationId: 'conv-1',
      body: 'hi',
      queuedAt: 1,
    });
    await enqueueOutboxMessage({
      clientMsgId: 'c-2',
      conversationId: 'conv-2',
      body: 'yo',
      queuedAt: 2,
    });

    expect(await listQueuedMessages('conv-1')).toEqual([
      { clientMsgId: 'c-1', conversationId: 'conv-1', body: 'hi', queuedAt: 1 },
    ]);
    expect(await listQueuedMessages('conv-2')).toEqual([
      { clientMsgId: 'c-2', conversationId: 'conv-2', body: 'yo', queuedAt: 2 },
    ]);
  });

  it('lists everything across conversations, oldest-queued first', async () => {
    await enqueueOutboxMessage({
      clientMsgId: 'c-2',
      conversationId: 'conv-2',
      body: 'second',
      queuedAt: 20,
    });
    await enqueueOutboxMessage({
      clientMsgId: 'c-1',
      conversationId: 'conv-1',
      body: 'first',
      queuedAt: 10,
    });

    expect((await listAllQueuedMessages()).map((m) => m.clientMsgId)).toEqual(['c-1', 'c-2']);
  });

  it('removes a message by clientMsgId', async () => {
    await enqueueOutboxMessage({
      clientMsgId: 'c-1',
      conversationId: 'conv-1',
      body: 'hi',
      queuedAt: 1,
    });
    await removeOutboxMessage('c-1');
    expect(await listQueuedMessages('conv-1')).toEqual([]);
  });

  it('removing a message that was never queued is a no-op', async () => {
    await expect(removeOutboxMessage('never-queued')).resolves.toBeUndefined();
  });

  it('re-enqueuing the same clientMsgId replaces rather than duplicates', async () => {
    await enqueueOutboxMessage({
      clientMsgId: 'c-1',
      conversationId: 'conv-1',
      body: 'first draft',
      queuedAt: 1,
    });
    await enqueueOutboxMessage({
      clientMsgId: 'c-1',
      conversationId: 'conv-1',
      body: 'edited',
      queuedAt: 1,
    });

    const queued = await listQueuedMessages('conv-1');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.body).toBe('edited');
  });
});

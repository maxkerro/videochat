import type { ConversationSummary, Message } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import { createLocalStore } from './store';
import { createTestDb } from './testDb';

const CONV = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
const OTHER = '9a1c0c7e-2b2c-4d5a-9f55-0d3b8f1a2b3d';
const USER = '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e';

function conversation(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    type: 'group',
    title: 'Team',
    lastSeq: 0,
    lastMessageAt: null,
    role: 'member',
    lastReadSeq: 0,
    peer: null,
    peerLastReadSeq: null,
    muted: false,
    unreadMentions: 0,
    lastMessage: null,
    ...extra,
  };
}

function message(seq: number, conversationId = CONV, body = `m${seq}`): Message {
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, '0')}`,
    conversationId,
    seq,
    senderId: USER,
    clientMsgId: `c${seq}`,
    type: 'text',
    body,
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  };
}

async function setup(max?: number) {
  const store = createLocalStore(await createTestDb(), { maxMessagesPerConversation: max });
  return store;
}

describe('local store', () => {
  it('keeps conversations in the order the server sent them, and replaces the list on save', async () => {
    const store = await setup();
    await store.saveConversations([conversation(CONV), conversation(OTHER, { title: 'B' })]);
    expect((await store.loadConversations()).map((c) => c.id)).toEqual([CONV, OTHER]);
    await store.saveConversations([conversation(OTHER)]);
    expect((await store.loadConversations()).map((c) => c.id)).toEqual([OTHER]);
  });

  it('puts a newly upserted conversation on top and updates an existing one in place', async () => {
    const store = await setup();
    await store.saveConversations([conversation(CONV)]);
    await store.upsertConversation(conversation(OTHER));
    expect((await store.loadConversations()).map((c) => c.id)).toEqual([OTHER, CONV]);
    await store.upsertConversation(conversation(CONV, { title: 'Renamed' }));
    const list = await store.loadConversations();
    expect(list.map((c) => c.id)).toEqual([OTHER, CONV]);
    expect(list[1]!.title).toBe('Renamed');
  });

  it('stores messages, returns the newest page oldest-first, and updates by id', async () => {
    const store = await setup();
    await store.saveMessages(CONV, [message(1), message(2), message(3)]);
    expect((await store.loadMessages(CONV, 2)).map((m) => m.seq)).toEqual([2, 3]);
    await store.saveMessages(CONV, [message(3, CONV, 'edited')]);
    const all = await store.loadMessages(CONV);
    expect(all.map((m) => m.body)).toEqual(['m1', 'm2', 'edited']);
  });

  it('saveLatestPage drops cached rows that do not join the new page, so no hole is ever cached', async () => {
    const store = await setup();
    await store.saveLatestPage(
      CONV,
      [1, 2, 3].map((n) => message(n)),
    );
    // Joins (seq 4 directly follows 3), even with overlap: nothing is dropped.
    await store.saveLatestPage(
      CONV,
      [3, 4, 5].map((n) => message(n)),
    );
    expect((await store.loadMessages(CONV)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    // The phone was away: the newest page starts at 50, so 1..5 would hide the missing middle.
    await store.saveLatestPage(
      CONV,
      [50, 51].map((n) => message(n)),
    );
    expect((await store.loadMessages(CONV)).map((m) => m.seq)).toEqual([50, 51]);
  });

  it('appendLive adds only messages that directly follow the cache, and updates cached ones', async () => {
    const store = await setup();
    await store.appendLive(CONV, [message(3)]); // empty cache, not the first message: skipped
    expect(await store.loadMessages(CONV)).toEqual([]);
    await store.appendLive(CONV, [message(1)]); // the conversation's first message
    await store.appendLive(CONV, [message(2)]);
    await store.appendLive(CONV, [message(5)]); // skips ahead: would leave a hole
    await store.appendLive(CONV, [message(2, CONV, 'edited')]); // an edit of a cached message
    await store.appendLive(CONV, [message(9, CONV, 'edit of an uncached message')]);
    const all = await store.loadMessages(CONV);
    expect(all.map((m) => [m.seq, m.body])).toEqual([
      [1, 'm1'],
      [2, 'edited'],
    ]);
  });

  it('appendLive takes a batch in order', async () => {
    const store = await setup();
    await store.saveLatestPage(CONV, [message(1)]);
    await store.appendLive(CONV, [message(3), message(2)]);
    expect((await store.loadMessages(CONV)).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('caps the cache at the newest N messages per conversation, independently', async () => {
    const store = await setup(3);
    await store.saveMessages(
      CONV,
      [1, 2, 3, 4, 5].map((n) => message(n)),
    );
    await store.saveMessages(OTHER, [message(1, OTHER)]);
    expect((await store.loadMessages(CONV)).map((m) => m.seq)).toEqual([3, 4, 5]);
    expect(await store.loadMessages(OTHER)).toHaveLength(1);
  });

  it('skips cached rows that no longer match the schema instead of failing', async () => {
    const db = await createTestDb();
    const store = createLocalStore(db);
    await db.run('INSERT INTO conversations (id, ord, json) VALUES (?, 0, ?)', [CONV, '{"x":1}']);
    await db.run('INSERT INTO messages (conversation_id, id, seq, json) VALUES (?, ?, 1, ?)', [
      CONV,
      'a',
      'not json',
    ]);
    expect(await store.loadConversations()).toEqual([]);
    expect(await store.loadMessages(CONV)).toEqual([]);
  });

  it('keeps the outbox in typing order, and tracks failed and requeued items', async () => {
    const store = await setup();
    await store.enqueue({ clientMsgId: 'a', conversationId: CONV, body: 'one', replyToId: null });
    await store.enqueue({ clientMsgId: 'b', conversationId: OTHER, body: 'two', replyToId: null });
    await store.enqueue({ clientMsgId: 'c', conversationId: CONV, body: 'three', replyToId: 'r' });
    expect((await store.listOutbox()).map((i) => i.clientMsgId)).toEqual(['a', 'b', 'c']);
    expect((await store.listOutbox(CONV)).map((i) => i.clientMsgId)).toEqual(['a', 'c']);

    await store.markOutboxFailed('a', 'Not allowed');
    expect((await store.listOutbox())[0]).toMatchObject({ state: 'failed', error: 'Not allowed' });
    await store.requeueOutbox('a');
    expect((await store.listOutbox())[0]).toMatchObject({ state: 'queued', error: null });

    await store.removeFromOutbox('b');
    expect((await store.listOutbox()).map((i) => i.clientMsgId)).toEqual(['a', 'c']);
    // Re-enqueueing the same id replaces rather than duplicates.
    await store.enqueue({ clientMsgId: 'a', conversationId: CONV, body: 'one!', replyToId: null });
    expect(await store.listOutbox(CONV)).toHaveLength(2);
  });

  it('drops cached messages of conversations that left the list', async () => {
    const store = await setup();
    await store.saveConversations([conversation(CONV), conversation(OTHER)]);
    await store.saveMessages(CONV, [message(1)]);
    await store.saveMessages(OTHER, [message(1, OTHER)]);
    await store.saveConversations([conversation(CONV)]); // removed from OTHER
    expect(await store.loadMessages(OTHER)).toEqual([]);
    expect(await store.loadMessages(CONV)).toHaveLength(1);
  });

  it('wipe removes everything, unsent messages and the owner included', async () => {
    const store = await setup();
    await store.setOwner(USER);
    await store.saveConversations([conversation(CONV)]);
    await store.saveMessages(CONV, [message(1)]);
    await store.enqueue({ clientMsgId: 'a', conversationId: CONV, body: 'x', replyToId: null });
    await store.wipe();
    expect(await store.getOwner()).toBeNull();
    expect(await store.loadConversations()).toEqual([]);
    expect(await store.loadMessages(CONV)).toEqual([]);
    expect(await store.listOutbox()).toEqual([]);
  });
});

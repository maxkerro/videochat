import type { ConversationSummary } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import { createLocalStore } from '../db/store';
import { createTestDb } from '../db/testDb';
import { prepareStoreForUser } from './hydrate';

const A = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
const B = '9a1c0c7e-2b2c-4d5a-9f55-0d3b8f1a2b3d';
const CONV = '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e';

const conversation: ConversationSummary = {
  id: CONV,
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
};

describe('prepareStoreForUser', () => {
  it('claims an empty database for the user and returns nothing to show', async () => {
    const store = createLocalStore(await createTestDb());
    await expect(prepareStoreForUser(store, A)).resolves.toEqual([]);
    await expect(store.getOwner()).resolves.toBe(A);
  });

  it("returns the owner's own cached inbox", async () => {
    const store = createLocalStore(await createTestDb());
    await prepareStoreForUser(store, A);
    await store.saveConversations([conversation]);
    await expect(prepareStoreForUser(store, A)).resolves.toEqual([conversation]);
  });

  it("another account signing in wipes the previous account's chats and unsent messages", async () => {
    const store = createLocalStore(await createTestDb());
    await prepareStoreForUser(store, A);
    await store.saveConversations([conversation]);
    await store.enqueue({
      clientMsgId: 'x',
      conversationId: CONV,
      body: 'secret',
      replyToId: null,
    });

    await expect(prepareStoreForUser(store, B)).resolves.toEqual([]);
    expect(await store.getOwner()).toBe(B);
    expect(await store.loadConversations()).toEqual([]);
    expect(await store.listOutbox()).toEqual([]);
  });

  it('does not wipe or claim the database once the session it was started for has ended', async () => {
    const store = createLocalStore(await createTestDb());
    await prepareStoreForUser(store, A);
    await store.saveConversations([conversation]);
    await expect(prepareStoreForUser(store, B, () => false)).resolves.toEqual([]);
    await expect(store.getOwner()).resolves.toBe(A);
    await expect(store.loadConversations()).resolves.toEqual([conversation]);
  });
});

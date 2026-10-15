import type { ConversationSummary, Message } from '@videochat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalStore, type LocalStore } from '../db/store';
import { createTestDb } from '../db/testDb';

const h = vi.hoisted(() => ({
  generation: 1,
  store: null as LocalStore | null,
  api: {
    markConversationRead: vi.fn(),
    toggleReaction: vi.fn(),
    startDirectConversation: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({
  session: { generation: () => h.generation, onSignedOut: () => () => undefined },
}));
vi.mock('../db/expoDb', () => ({ getLocalStore: () => Promise.resolve(h.store!) }));
vi.mock('./api', () => h.api);

const CONV = '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e';
const summary = (extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: CONV,
  type: 'group',
  title: 'A-only group',
  lastSeq: 1,
  lastMessageAt: null,
  role: 'member',
  lastReadSeq: 1,
  peer: null,
  peerLastReadSeq: null,
  muted: false,
  unreadMentions: 0,
  lastMessage: null,
  ...extra,
});
const message: Message = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5F01',
  conversationId: CONV,
  seq: 1,
  senderId: null,
  clientMsgId: null,
  type: 'text',
  body: 'from account A',
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function load() {
  const [{ queryClient }, actions, runner, { keys }] = await Promise.all([
    import('./queryClient'),
    import('./actions'),
    import('./outboxRunner'),
    import('./keys'),
  ]);
  return { queryClient, actions, runner, keys };
}

beforeEach(async () => {
  h.generation = 1;
  h.store = createLocalStore(await createTestDb());
  vi.clearAllMocks();
});

describe('mutations that resolve after the account changed', () => {
  it("markRead: A's answer reaches neither B's inbox cache nor B's database", async () => {
    const { queryClient, actions, keys } = await load();
    queryClient.setQueryData(keys.conversations, []); // B's (empty) inbox
    h.api.markConversationRead.mockImplementation(async () => {
      h.generation = 2; // A signs out and B signs in while the request is in flight
      return summary();
    });

    await actions.markRead(CONV, 1);

    expect(queryClient.getQueryData(keys.conversations)).toEqual([]);
    expect(queryClient.getQueryData(keys.conversation(CONV))).toBeUndefined();
    expect(await h.store!.loadConversations()).toEqual([]);
  });

  it('markRead in the same session still updates the cache and the database', async () => {
    const { queryClient, actions, keys } = await load();
    queryClient.setQueryData(keys.conversations, []);
    h.api.markConversationRead.mockResolvedValue(summary());

    await actions.markRead(CONV, 1);

    expect(queryClient.getQueryData(keys.conversations)).toEqual([summary()]);
    expect(await h.store!.loadConversations()).toEqual([summary()]);
  });

  it("startDirect: A's new conversation is not prepended to B's inbox", async () => {
    const { queryClient, actions, keys } = await load();
    queryClient.setQueryData(keys.conversations, []);
    h.api.startDirectConversation.mockImplementation(async () => {
      h.generation = 2;
      return summary();
    });
    await actions.startDirect('9a1c0c7e-2b2c-4d5a-9f55-0d3b8f1a2b3d');
    expect(queryClient.getQueryData(keys.conversations)).toEqual([]);
    expect(await h.store!.loadConversations()).toEqual([]);
  });

  it("recordMessage: A's message rows do not land in B's cache or database", async () => {
    const { queryClient, runner, keys } = await load();
    queryClient.setQueryData(keys.messages(CONV), { messages: [], hasMore: false });
    await runner.recordMessage(message, 1 /* captured before the request */);
    h.generation = 2;
    await runner.recordMessage({ ...message, id: '01ARZ3NDEKTSV4RRFFQ69G5F02', seq: 2 }, 1);

    const cached = queryClient.getQueryData<{ messages: Message[] }>(keys.messages(CONV));
    expect(cached?.messages.map((m) => m.seq)).toEqual([1]); // only the pre-switch one
    expect((await h.store!.loadMessages(CONV)).map((m) => m.seq)).toEqual([1]);
  });

  it("react: A's reaction answer is dropped after the switch", async () => {
    const { queryClient, actions, keys } = await load();
    queryClient.setQueryData(keys.messages(CONV), { messages: [message], hasMore: false });
    h.api.toggleReaction.mockImplementation(async () => {
      h.generation = 2;
      return {
        conversationId: CONV,
        messageId: message.id,
        reactions: [{ emoji: '👍', count: 1, userIds: [CONV] }],
      };
    });
    await actions.react(CONV, message.id, '👍');
    const cached = queryClient.getQueryData<{ messages: Message[] }>(keys.messages(CONV));
    expect(cached?.messages[0]).not.toHaveProperty('reactions');
  });
});

import type { ConversationSummary, Message, Presence } from '@videochat/shared';
import { makeEnvelope } from '@videochat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalStore, type LocalStore } from '../db/store';
import { createTestDb } from '../db/testDb';

const h = vi.hoisted(() => ({ generation: 1, store: null as LocalStore | null }));

vi.mock('../lib/api', () => ({
  session: { generation: () => h.generation, onSignedOut: () => () => undefined },
}));
vi.mock('../db/expoDb', () => ({ getLocalStore: () => Promise.resolve(h.store!) }));

const ME = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
const PEER = '9a1c0c7e-2b2c-4d5a-9f55-0d3b8f1a2b3d';
const CONV = '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e';

const msg = (seq: number, extra: Partial<Message> = {}): Message => ({
  id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, '0')}`,
  conversationId: CONV,
  seq,
  senderId: PEER,
  clientMsgId: null,
  type: 'text',
  body: `m${seq}`,
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const summary: ConversationSummary = {
  id: CONV,
  type: 'direct',
  title: null,
  lastSeq: 2,
  lastMessageAt: null,
  role: 'member',
  lastReadSeq: 1,
  peer: { id: PEER, username: 'ben', displayName: 'Ben', avatarUrl: null },
  peerLastReadSeq: 0,
  muted: false,
  unreadMentions: 0,
  lastMessage: null,
};

async function load() {
  vi.resetModules();
  const [{ queryClient }, events, { keys }, typing] = await Promise.all([
    import('../data/queryClient'),
    import('./events'),
    import('../data/keys'),
    import('./typing'),
  ]);
  return { queryClient, events, keys, typing };
}

const ctx = () => ({ myId: ME, generation: 1 });
const env = (type: string, payload: unknown) => makeEnvelope(type, payload, 'e');

describe('applyRealtimeEvent', () => {
  beforeEach(async () => {
    h.generation = 1;
    h.store = createLocalStore(await createTestDb());
  });

  it('adds a new message to the open conversation and, when it joins the cache, the on-device copy', async () => {
    const { queryClient, events, keys } = await load();
    await h.store!.saveLatestPage(CONV, [msg(1), msg(2)]);
    queryClient.setQueryData(keys.messages(CONV), { messages: [msg(1), msg(2)], hasMore: false });
    events.applyRealtimeEvent(env('message.new', msg(3)), ctx());
    expect(
      queryClient
        .getQueryData<{ messages: Message[] }>(keys.messages(CONV))!
        .messages.map((m) => m.seq),
    ).toEqual([1, 2, 3]);
    await vi.waitFor(async () =>
      expect((await h.store!.loadMessages(CONV, 10)).map((m) => m.seq)).toEqual([1, 2, 3]),
    );
  });

  it('does not put a message into the on-device copy when it would leave a gap', async () => {
    const { events } = await load();
    events.applyRealtimeEvent(env('message.new', msg(3)), ctx());
    events.applyRealtimeEvent(env('message.updated', msg(7)), ctx());
    await new Promise((r) => setTimeout(r, 50));
    expect(await h.store!.loadMessages(CONV, 10)).toEqual([]);
  });

  it('refetches instead of showing a hole when a message skips ahead', async () => {
    const { queryClient, events, keys } = await load();
    queryClient.setQueryData(keys.messages(CONV), { messages: [msg(1)], hasMore: false });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    events.applyRealtimeEvent(env('message.new', msg(5)), ctx());
    expect(
      queryClient.getQueryData<{ messages: Message[] }>(keys.messages(CONV))!.messages,
    ).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: keys.messages(CONV) });
  });

  it('CHAT-073: a live mention or an edit re-reads the inbox, whose count comes from the server', async () => {
    const { queryClient, events, keys } = await load();
    events.resetInboxThrottle();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    events.applyRealtimeEvent(env('message.new', { ...msg(2), mentions: [ME] }), ctx());
    expect(spy).toHaveBeenCalledWith({ queryKey: keys.conversations });
    spy.mockClear();
    events.resetInboxThrottle();
    events.applyRealtimeEvent(env('message.updated', { ...msg(2), mentions: [ME] }), ctx());
    expect(spy).toHaveBeenCalledWith({ queryKey: keys.conversations });
  });

  it('does not create a cache entry for a conversation that is not open', async () => {
    const { queryClient, events, keys } = await load();
    events.applyRealtimeEvent(env('message.new', msg(1)), ctx());
    expect(queryClient.getQueryData(keys.messages(CONV))).toBeUndefined();
  });

  it("drops events from a session that has ended (another account's data)", async () => {
    const { queryClient, events, keys } = await load();
    queryClient.setQueryData(keys.messages(CONV), { messages: [msg(1)], hasMore: false });
    h.generation = 2;
    events.applyRealtimeEvent(env('message.new', msg(2)), ctx());
    expect(
      queryClient.getQueryData<{ messages: Message[] }>(keys.messages(CONV))!.messages,
    ).toHaveLength(1);
  });

  it('applies an edit or delete and new reactions to the loaded message', async () => {
    const { queryClient, events, keys } = await load();
    queryClient.setQueryData(keys.messages(CONV), { messages: [msg(1), msg(2)], hasMore: false });
    events.applyRealtimeEvent(
      env('message.updated', msg(2, { body: 'edited', editedAt: '2026-01-01T00:01:00.000Z' })),
      ctx(),
    );
    events.applyRealtimeEvent(
      env('message.reactions', {
        conversationId: CONV,
        messageId: msg(1).id,
        reactions: [{ emoji: '👍', count: 1, userIds: [PEER] }],
      }),
      ctx(),
    );
    const state = queryClient.getQueryData<{ messages: Message[] }>(keys.messages(CONV))!;
    expect(state.messages[1]!.body).toBe('edited');
    expect(state.messages[0]!.reactions).toHaveLength(1);
  });

  it("read receipts: the peer's read position and my own other device's", async () => {
    const { queryClient, events, keys } = await load();
    queryClient.setQueryData(keys.conversation(CONV), summary);
    queryClient.setQueryData(keys.conversations, [summary]);
    events.applyRealtimeEvent(
      env('conversation.read', { conversationId: CONV, userId: PEER, lastReadSeq: 2 }),
      ctx(),
    );
    events.applyRealtimeEvent(
      env('conversation.read', { conversationId: CONV, userId: ME, lastReadSeq: 2 }),
      ctx(),
    );
    const one = queryClient.getQueryData<ConversationSummary>(keys.conversation(CONV))!;
    expect(one.peerLastReadSeq).toBe(2);
    expect(one.lastReadSeq).toBe(2);
    expect(
      queryClient.getQueryData<ConversationSummary[]>(keys.conversations)![0]!.peerLastReadSeq,
    ).toBe(2);
  });

  it('CHAT-073: reading everything clears my unread mentions', async () => {
    const { queryClient, events, keys } = await load();
    queryClient.setQueryData(keys.conversations, [
      { ...summary, lastSeq: 5, lastReadSeq: 1, unreadMentions: 2 },
    ]);
    events.applyRealtimeEvent(
      env('conversation.read', { conversationId: CONV, userId: ME, lastReadSeq: 5 }),
      ctx(),
    );
    expect(
      queryClient.getQueryData<ConversationSummary[]>(keys.conversations)![0]!.unreadMentions,
    ).toBe(0);
  });

  it('typing: shows others, ignores my own signal, and clears when their message arrives', async () => {
    const { events, typing } = await load();
    events.applyRealtimeEvent(
      env('conversation.typing', { conversationId: CONV, userId: PEER, displayName: 'Ben' }),
      ctx(),
    );
    events.applyRealtimeEvent(
      env('conversation.typing', { conversationId: CONV, userId: ME, displayName: 'Me' }),
      ctx(),
    );
    expect(typing.typingNames(CONV)).toEqual(['Ben']);
    events.applyRealtimeEvent(env('message.new', msg(1)), ctx());
    expect(typing.typingNames(CONV)).toEqual([]);
  });

  it('presence changes update the cached presence lists', async () => {
    const { queryClient, events } = await load();
    const before: Presence[] = [{ userId: PEER, online: false, lastSeenAt: null }];
    queryClient.setQueryData(['presence', [PEER]], before);
    events.applyRealtimeEvent(
      env('presence.changed', { userId: PEER, online: true, lastSeenAt: null }),
      ctx(),
    );
    expect(queryClient.getQueryData<Presence[]>(['presence', [PEER]])![0]!.online).toBe(true);
  });

  it('ignores malformed payloads and unknown event types', async () => {
    const { queryClient, events, keys } = await load();
    queryClient.setQueryData(keys.messages(CONV), { messages: [msg(1)], hasMore: false });
    events.applyRealtimeEvent(env('message.new', { nonsense: true }), ctx());
    events.applyRealtimeEvent(env('call.invite', {}), ctx());
    expect(
      queryClient.getQueryData<{ messages: Message[] }>(keys.messages(CONV))!.messages,
    ).toHaveLength(1);
  });
});

describe('refreshInbox', () => {
  it('refetches the inbox at most about once a second', async () => {
    vi.useFakeTimers();
    try {
      const { queryClient, events, keys } = await load();
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      events.resetInboxThrottle();
      const t0 = Date.now();
      events.refreshInbox(t0);
      events.refreshInbox(t0 + 100);
      events.refreshInbox(t0 + 200);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith({ queryKey: keys.conversations });
    } finally {
      vi.useRealTimers();
    }
  });
});

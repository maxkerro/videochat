import { markConversationRead, markConversationUnread } from './conversations.js';

/** A minimal fake of the drizzle `update().set().where().returning()` chain, just enough to drive
 *  `markConversationRead`/`markConversationUnread`'s "did it match an active membership row"
 *  logic without a real database -- the actual `GREATEST`/`LEAST` SQL is exercised by the e2e
 *  test instead (see `conversations.e2e.spec.ts`'s CHAT-019 block), since a fake can't evaluate
 *  raw `sql` fragments. `resultRow` is whatever the (fake) database would have returned after
 *  applying the update -- the caller controls it directly, mirroring how these tests are written
 *  for `messages.spec.ts`. */
function fakeUpdateDb(resultRow: unknown) {
  const calls: { set: unknown; where: unknown }[] = [];
  const builder = {
    update: vi.fn(() => builder),
    set: vi.fn((value: unknown) => {
      calls.push({ set: value, where: undefined });
      return builder;
    }),
    where: vi.fn((value: unknown) => {
      calls[calls.length - 1]!.where = value;
      return builder;
    }),
    returning: vi.fn(() => Promise.resolve(resultRow === undefined ? [] : [resultRow])),
  };
  return { db: builder as never, calls };
}

describe('markConversationRead', () => {
  it('returns the updated membership row when the update matches an active member', async () => {
    const updatedRow = { conversationId: 'conv-1', userId: 'user-1', lastReadSeq: 5 };
    const { db } = fakeUpdateDb(updatedRow);

    const result = await markConversationRead(db, 'conv-1', 'user-1', 5);

    expect(result).toBe(updatedRow);
  });

  it('returns undefined when nothing matched (not a member, or already left)', async () => {
    const { db } = fakeUpdateDb(undefined);

    const result = await markConversationRead(db, 'conv-1', 'ghost', 5);

    expect(result).toBeUndefined();
  });
});

describe('markConversationUnread', () => {
  it('returns the updated membership row when the update matches an active member', async () => {
    const updatedRow = { conversationId: 'conv-1', userId: 'user-1', lastReadSeq: 4 };
    const { db } = fakeUpdateDb(updatedRow);

    const result = await markConversationUnread(db, 'conv-1', 'user-1', 4);

    expect(result).toBe(updatedRow);
  });

  it('returns undefined when nothing matched (not a member, or already left)', async () => {
    const { db } = fakeUpdateDb(undefined);

    const result = await markConversationUnread(db, 'conv-1', 'ghost', 4);

    expect(result).toBeUndefined();
  });
});

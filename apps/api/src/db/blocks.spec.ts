import {
  blockUser,
  hasBlockEitherDirection,
  isBlocked,
  isSenderBlockedInDirectConversation,
  listBlockedUsers,
  listBlockRelationshipUserIds,
  unblockUser,
} from './blocks.js';

/** A minimal fake of the drizzle query-builder chain these functions call -- same idea as
 *  `db/messages.spec.ts`'s own `fakeDb`. `rows` is what the terminal call in the chain
 *  (`limit`/`orderBy`/awaiting the builder directly) resolves to. */
function fakeSelect(rows: unknown[]) {
  const calls: { where?: unknown[]; limit?: number } = { where: [] };
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    from: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    where: vi.fn((cond: unknown) => {
      (calls.where as unknown[]).push(cond);
      return builder;
    }),
    orderBy: vi.fn(() => Promise.resolve(rows)),
    limit: vi.fn((n: number) => {
      calls.limit = n;
      return Promise.resolve(rows.slice(0, n));
    }),
    // Drizzle's own query builder is thenable (awaiting it runs the query), which
    // `listBlockRelationshipUserIds` relies on -- it has no `.limit()`/`.orderBy()` to terminate
    // the chain on, just `await db.select()...where(...)` directly.
    then: (resolve: (value: unknown[]) => void) => resolve(rows),
  };
  return { db: builder as never, calls };
}

function fakeInsert() {
  const values = vi.fn(() => ({ onConflictDoNothing: vi.fn(() => Promise.resolve()) }));
  const builder = { insert: vi.fn(() => ({ values })) };
  return { db: builder as never, values };
}

function fakeDelete() {
  const where = vi.fn(() => Promise.resolve());
  const builder = { delete: vi.fn(() => ({ where })) };
  return { db: builder as never, where };
}

describe('isBlocked', () => {
  it('is true when a matching (blocker, blocked) row comes back', async () => {
    const { db } = fakeSelect([{ blockerId: 'a' }]);
    expect(await isBlocked(db, 'a', 'b')).toBe(true);
  });

  it('is false when nothing matches', async () => {
    const { db } = fakeSelect([]);
    expect(await isBlocked(db, 'a', 'b')).toBe(false);
  });
});

describe('hasBlockEitherDirection', () => {
  it('is true when a row matches either direction', async () => {
    const { db } = fakeSelect([{ blockerId: 'b' }]);
    expect(await hasBlockEitherDirection(db, 'a', 'b')).toBe(true);
  });

  it('is false with no block either way', async () => {
    const { db } = fakeSelect([]);
    expect(await hasBlockEitherDirection(db, 'a', 'b')).toBe(false);
  });
});

describe('listBlockRelationshipUserIds', () => {
  it('resolves each row to whichever side is not `userId`, deduplicated', async () => {
    const { db } = fakeSelect([
      { blockerId: 'me', blockedId: 'anna' }, // I blocked Anna
      { blockerId: 'ben', blockedId: 'me' }, // Ben blocked me
      { blockerId: 'me', blockedId: 'anna' }, // a duplicate row would collapse via the Set anyway
    ]);
    const ids = await listBlockRelationshipUserIds(db, 'me');
    expect(ids).toEqual(new Set(['anna', 'ben']));
  });

  it('is empty when there is no block relationship at all', async () => {
    const { db } = fakeSelect([]);
    expect(await listBlockRelationshipUserIds(db, 'me')).toEqual(new Set());
  });
});

describe('listBlockedUsers', () => {
  it('returns most-recently-blocked first', async () => {
    // The query orders ascending by createdAt; the function reverses it to most-recent-first.
    const { db } = fakeSelect([
      { user: { id: 'anna' }, createdAt: new Date('2026-01-01') },
      { user: { id: 'ben' }, createdAt: new Date('2026-02-01') },
    ]);
    const rows = await listBlockedUsers(db, 'me');
    expect(rows.map((r) => r.user.id)).toEqual(['ben', 'anna']);
  });

  it('is empty when nobody is blocked', async () => {
    const { db } = fakeSelect([]);
    expect(await listBlockedUsers(db, 'me')).toEqual([]);
  });
});

describe('isSenderBlockedInDirectConversation', () => {
  it('is true when the join finds the other member has blocked the sender', async () => {
    const { db } = fakeSelect([{ blockerId: 'peer' }]);
    expect(await isSenderBlockedInDirectConversation(db, 'conv-1', 'me')).toBe(true);
  });

  it('is false when no such row comes back (not blocked, or not a direct conversation)', async () => {
    const { db } = fakeSelect([]);
    expect(await isSenderBlockedInDirectConversation(db, 'conv-1', 'me')).toBe(false);
  });
});

describe('blockUser', () => {
  it('inserts the (blocker, blocked) pair, ignoring an already-existing block', async () => {
    const { db, values } = fakeInsert();
    await blockUser(db, 'me', 'anna');
    expect(values).toHaveBeenCalledWith({ blockerId: 'me', blockedId: 'anna' });
  });
});

describe('unblockUser', () => {
  it('deletes the (blocker, blocked) row', async () => {
    const { db, where } = fakeDelete();
    await unblockUser(db, 'me', 'anna');
    expect(where).toHaveBeenCalledTimes(1);
  });
});

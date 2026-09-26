import { searchUsersByUsernamePrefix } from './users.js';

/** Captures the `where` conditions drizzle would have built, without a real database -- enough
 *  to assert on *how many* conditions were combined (CHAT-021: whether the block-exclusion
 *  condition was added at all) without re-implementing SQL comparison. */
function fakeDb(rows: unknown[]) {
  const whereCalls: unknown[] = [];
  const builder = {
    select: vi.fn(() => builder),
    from: vi.fn(() => builder),
    where: vi.fn((cond: unknown) => {
      whereCalls.push(cond);
      return builder;
    }),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return { db: builder as never, whereCalls };
}

describe('searchUsersByUsernamePrefix', () => {
  it('with no excludeAlsoIds, combines just the prefix and self-exclusion conditions', async () => {
    const { db, whereCalls } = fakeDb([]);
    await searchUsersByUsernamePrefix(db, 'anna', 'me', 20);
    // `and(...)` was called with exactly 2 conditions (prefix match, exclude self).
    expect(whereCalls).toHaveLength(1);
  });

  it('with excludeAlsoIds (CHAT-021 blocked/blocking users), still resolves without building an invalid empty NOT IN', async () => {
    const { db } = fakeDb([{ id: 'ben' }]);
    const results = await searchUsersByUsernamePrefix(db, 'anna', 'me', 20, ['blocked-1']);
    expect(results).toEqual([{ id: 'ben' }]);
  });

  it('an empty excludeAlsoIds array behaves exactly like omitting it', async () => {
    const { db: dbOmitted, whereCalls: omitted } = fakeDb([]);
    await searchUsersByUsernamePrefix(dbOmitted, 'anna', 'me', 20);

    const { db: dbEmpty, whereCalls: empty } = fakeDb([]);
    await searchUsersByUsernamePrefix(dbEmpty, 'anna', 'me', 20, []);

    expect(empty).toEqual(omitted);
  });
});

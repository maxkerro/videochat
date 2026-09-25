import { directKeyFor, listMessagesPage } from './messages.js';

/** A minimal fake of the drizzle query-builder chain `listMessagesPage` calls -- just enough to
 *  drive its `hasMore`/ordering logic without a real database. `where`/`orderBy` are no-ops that
 *  return the same builder (this test isn't asserting on the SQL they build -- that's covered by
 *  the real-database e2e paging test); `limit` resolves however many fake rows the test hands it,
 *  descending-seq order, matching what the real query returns. */
function fakeDb(rowsBySeqDesc: { seq: number }[]) {
  const limitCalls: number[] = [];
  const builder = {
    select: vi.fn(() => builder),
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    orderBy: vi.fn(() => builder),
    limit: vi.fn((n: number) => {
      limitCalls.push(n);
      return Promise.resolve(rowsBySeqDesc.slice(0, n));
    }),
  };
  return { db: builder as never, limitCalls };
}

describe('listMessagesPage', () => {
  it('requests limit + 1 rows, and reports hasMore=false when that comes back short', async () => {
    const { db, limitCalls } = fakeDb([{ seq: 5 }, { seq: 4 }, { seq: 3 }]);

    const page = await listMessagesPage(db, 'conv-1', { limit: 5 });

    expect(limitCalls).toEqual([6]);
    expect(page.hasMore).toBe(false);
    // Rows come back seq-descending from the query; the page reverses them to oldest-first.
    expect(page.rows.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  it('reports hasMore=true and drops the extra probe row when exactly on the boundary', async () => {
    // 6 rows available for a limit of 5 -- the probe row (the 6th) proves there's another page,
    // but must never leak into the page itself.
    const { db, limitCalls } = fakeDb([
      { seq: 6 },
      { seq: 5 },
      { seq: 4 },
      { seq: 3 },
      { seq: 2 },
      { seq: 1 },
    ]);

    const page = await listMessagesPage(db, 'conv-1', { limit: 5 });

    expect(limitCalls).toEqual([6]);
    expect(page.hasMore).toBe(true);
    expect(page.rows).toHaveLength(5);
    expect(page.rows.map((r) => r.seq)).toEqual([2, 3, 4, 5, 6]);
  });

  it('with no rows at all, returns an empty page and hasMore=false', async () => {
    const { db } = fakeDb([]);

    const page = await listMessagesPage(db, 'conv-1', { limit: 5 });

    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe('directKeyFor', () => {
  it('is order-independent for the same pair of users', () => {
    expect(directKeyFor('a', 'b')).toBe(directKeyFor('b', 'a'));
  });

  it('sorts the two ids into a stable "a:b" key', () => {
    expect(directKeyFor('b', 'a')).toBe('a:b');
  });

  it('rejects a user paired with themselves', () => {
    expect(() => directKeyFor('same', 'same')).toThrow(/two different users/);
  });
});

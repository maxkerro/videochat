import { count, eq, sql } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import { appendMessage, directKeyFor } from '../src/db/messages.js';
import { conversations, memberships, messages, users } from '../src/db/schema.js';
import { seedDemoData } from '../src/db/seed.js';
import { freshDatabase, hasInfra } from './helpers.js';

/** Postgres error code of a failed query (drizzle wraps the driver error in `cause`). */
async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

describe.skipIf(!hasInfra)('database schema v1 (CHAT-004)', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await freshDatabase());
  });
  afterAll(() => close());

  async function makeUser(username: string) {
    const [u] = await db
      .insert(users)
      .values({ username, email: `${username}@test.dev`, displayName: username })
      .returning();
    return u!;
  }

  async function makeGroup() {
    const [c] = await db.insert(conversations).values({ type: 'group', title: 'g' }).returning();
    return c!;
  }

  it('migrations run forward, back (reset) and forward again', async () => {
    // freshDatabase() already did reset + migrate; doing it twice more proves it is repeatable.
    const again = await freshDatabase();
    const result = await again.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(result.rows[0]?.n).toBe(7); // users, devices, conversations, memberships, messages, refresh_tokens, auth_tokens
    await again.close();
  });

  it('seed creates 3 users, a DM and a group chat, and is idempotent', async () => {
    const first = await seedDemoData(db);
    expect(first.created).toBe(true);
    const second = await seedDemoData(db);
    expect(second.created).toBe(false);

    const [userCount] = await db.select({ n: count() }).from(users);
    expect(userCount?.n).toBe(3);
    const convs = await db.select().from(conversations);
    expect(convs.map((c) => c.type).sort()).toEqual(['direct', 'group']);
  });

  it('usernames and emails are unique case-insensitively', async () => {
    await makeUser('dora');
    const code = await pgErrorCode(
      db.insert(users).values({ username: 'DORA', email: 'other@test.dev', displayName: 'x' }),
    );
    expect(code).toBe('23505'); // unique_violation
  });

  it('allows only one direct conversation per pair of users', async () => {
    const a = await makeUser('eve');
    const b = await makeUser('finn');
    await db.insert(conversations).values({ type: 'direct', directKey: directKeyFor(a.id, b.id) });
    const code = await pgErrorCode(
      db.insert(conversations).values({ type: 'direct', directKey: directKeyFor(b.id, a.id) }),
    );
    expect(code).toBe('23505');
  });

  it('requires direct_key exactly for direct conversations', async () => {
    expect(await pgErrorCode(db.insert(conversations).values({ type: 'direct' }))).toBe('23514');
    expect(
      await pgErrorCode(db.insert(conversations).values({ type: 'group', directKey: 'x:y' })),
    ).toBe('23514'); // check_violation
  });

  it('assigns gap-free, unique seq numbers under concurrent appends', async () => {
    const sender = await makeUser('gina');
    const conv = await makeGroup();
    await db.insert(memberships).values({ conversationId: conv.id, userId: sender.id });

    const rows = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        appendMessage(db, { conversationId: conv.id, senderId: sender.id, body: `m${i}` }),
      ),
    );
    expect(rows.map((r) => r.seq).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    const [c] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(c?.lastSeq).toBe(25);
  });

  it('is idempotent on (sender, client_msg_id)', async () => {
    const sender = await makeUser('hank');
    const conv = await makeGroup();
    const input = { conversationId: conv.id, senderId: sender.id, body: 'hi', clientMsgId: 'c-1' };
    const first = await appendMessage(db, input);
    const retry = await appendMessage(db, input);
    expect(retry.id).toBe(first.id);
    const [n] = await db
      .select({ n: count() })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(n?.n).toBe(1);
  });

  it('refuses to append a message to a conversation that does not exist', async () => {
    const sender = await makeUser('ivan');
    await expect(
      appendMessage(db, {
        conversationId: '00000000-0000-0000-0000-000000000000',
        senderId: sender.id,
        body: 'hello?',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects message bodies over 4,000 characters', async () => {
    const conv = await makeGroup();
    const code = await pgErrorCode(
      db.insert(messages).values({
        id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
        conversationId: conv.id,
        seq: 1,
        senderId: null,
        body: 'x'.repeat(4001),
      }),
    );
    expect(code).toBe('23514');
  });
});

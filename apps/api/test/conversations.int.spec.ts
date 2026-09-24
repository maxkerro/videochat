import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import {
  findOrCreateDirectConversation,
  isConversationMember,
  listConversationsForUser,
} from '../src/db/conversations.js';
import { appendMessage } from '../src/db/messages.js';
import { conversations, memberships, users } from '../src/db/schema.js';
import { freshDatabase, hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('conversations (CHAT-012)', () => {
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

  describe('isConversationMember', () => {
    it('is true for a current member and false for a non-member', async () => {
      const a = await makeUser('member-a');
      const b = await makeUser('member-b');
      const [conv] = await db
        .insert(conversations)
        .values({ type: 'group', title: 'g' })
        .returning();
      await db.insert(memberships).values({ conversationId: conv!.id, userId: a.id });

      expect(await isConversationMember(db, conv!.id, a.id)).toBe(true);
      expect(await isConversationMember(db, conv!.id, b.id)).toBe(false);
    });

    it('is false for a member who has left', async () => {
      const a = await makeUser('left-a');
      const [conv] = await db
        .insert(conversations)
        .values({ type: 'group', title: 'g' })
        .returning();
      await db
        .insert(memberships)
        .values({ conversationId: conv!.id, userId: a.id, leftAt: new Date() });

      expect(await isConversationMember(db, conv!.id, a.id)).toBe(false);
    });
  });

  describe('findOrCreateDirectConversation', () => {
    it('creates a new direct conversation with both users as members', async () => {
      const a = await makeUser('dm-a');
      const b = await makeUser('dm-b');

      const conv = await findOrCreateDirectConversation(db, a.id, b.id);

      expect(conv.type).toBe('direct');
      expect(conv.role).toBe('member');
      expect(conv.lastReadSeq).toBe(0);
      const members = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.conversationId, conv.id));
      expect(members.map((m) => m.userId).sort()).toEqual([a.id, b.id].sort());
    });

    it('returns the existing conversation on a second call, from either side', async () => {
      const a = await makeUser('dm-c');
      const b = await makeUser('dm-d');

      const first = await findOrCreateDirectConversation(db, a.id, b.id);
      const second = await findOrCreateDirectConversation(db, b.id, a.id);

      expect(second.id).toBe(first.id);
      const all = await db.select().from(conversations);
      expect(all.filter((c) => c.id === first.id)).toHaveLength(1);
    });

    it('produces exactly one conversation under concurrent creation from both sides', async () => {
      const a = await makeUser('dm-race-a');
      const b = await makeUser('dm-race-b');

      const [left, right] = await Promise.all([
        findOrCreateDirectConversation(db, a.id, b.id),
        findOrCreateDirectConversation(db, b.id, a.id),
      ]);

      expect(left.id).toBe(right.id);
      const members = await db
        .select()
        .from(memberships)
        .where(eq(memberships.conversationId, left.id));
      expect(members).toHaveLength(2);
    });
  });

  describe('listConversationsForUser', () => {
    it('lists only conversations the user currently belongs to, newest activity first', async () => {
      const a = await makeUser('list-a');
      const b = await makeUser('list-b');
      const c = await makeUser('list-c');

      const conv1 = await findOrCreateDirectConversation(db, a.id, b.id);
      const conv2 = await findOrCreateDirectConversation(db, a.id, c.id);
      // Bump conv1's lastMessageAt above conv2's by appending to it last.
      await appendMessage(db, { conversationId: conv2.id, senderId: a.id, body: 'hi c' });
      await appendMessage(db, { conversationId: conv1.id, senderId: a.id, body: 'hi b' });

      const list = await listConversationsForUser(db, a.id);
      const ids = list.map((r) => r.id);
      expect(ids[0]).toBe(conv1.id);
      expect(ids).toContain(conv2.id);

      const forB = await listConversationsForUser(db, b.id);
      expect(forB.map((r) => r.id)).toEqual([conv1.id]);
    });

    it('resolves the peer for a direct conversation, excluding the viewer', async () => {
      const a = await makeUser('peer-a');
      const b = await makeUser('peer-b');
      const conv = await findOrCreateDirectConversation(db, a.id, b.id);

      const [forA] = await listConversationsForUser(db, a.id);
      const [forB] = await listConversationsForUser(db, b.id);

      expect(forA!.id).toBe(conv.id);
      expect(forA!.peer?.id).toBe(b.id);
      expect(forB!.peer?.id).toBe(a.id);
    });

    it('omits a conversation the user has left', async () => {
      const a = await makeUser('gone-a');
      const b = await makeUser('gone-b');
      const conv = await findOrCreateDirectConversation(db, a.id, b.id);
      await db
        .update(memberships)
        .set({ leftAt: new Date() })
        .where(and(eq(memberships.userId, a.id), eq(memberships.conversationId, conv.id)));

      const list = await listConversationsForUser(db, a.id);
      expect(list.map((r) => r.id)).not.toContain(conv.id);
    });
  });
});

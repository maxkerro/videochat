import { and, eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import {
  addGroupMembers,
  countActiveMembers,
  createGroupConversation,
  findOrCreateDirectConversation,
  getMembership,
  isConversationMember,
  leaveConversation,
  listActiveMembers,
  listConversationsForUser,
  removeGroupMember,
  renameConversation,
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

  describe('createGroupConversation (CHAT-018)', () => {
    it('creates the group with the creator as admin and everyone else a member', async () => {
      const creator = await makeUser('group-creator-a');
      const ben = await makeUser('group-ben-a');
      const carl = await makeUser('group-carl-a');

      const conv = await createGroupConversation(db, {
        title: 'Weekend trip',
        createdBy: creator.id,
        memberIds: [ben.id, carl.id],
      });

      expect(conv.type).toBe('group');
      expect(conv.title).toBe('Weekend trip');
      expect(conv.role).toBe('admin');
      const rows = await db
        .select({ userId: memberships.userId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.conversationId, conv.id));
      expect(rows.find((r) => r.userId === creator.id)?.role).toBe('admin');
      expect(rows.find((r) => r.userId === ben.id)?.role).toBe('member');
      expect(rows.find((r) => r.userId === carl.id)?.role).toBe('member');
    });
  });

  describe('getMembership / countActiveMembers (CHAT-018)', () => {
    it('returns the active membership row, and undefined for a non-member or a left member', async () => {
      const creator = await makeUser('membership-a');
      const ben = await makeUser('membership-b');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });

      expect((await getMembership(db, conv.id, creator.id))?.role).toBe('admin');
      expect(
        await getMembership(db, conv.id, '00000000-0000-0000-0000-000000000000'),
      ).toBeUndefined();

      await removeGroupMember(db, conv.id, ben.id);
      expect(await getMembership(db, conv.id, ben.id)).toBeUndefined();
    });

    it('counts only active members', async () => {
      const creator = await makeUser('count-a');
      const ben = await makeUser('count-b');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });
      expect(await countActiveMembers(db, conv.id)).toBe(2);

      await removeGroupMember(db, conv.id, ben.id);
      expect(await countActiveMembers(db, conv.id)).toBe(1);
    });
  });

  describe('renameConversation (CHAT-018)', () => {
    it('updates the title', async () => {
      const creator = await makeUser('rename-a');
      const conv = await createGroupConversation(db, {
        title: 'Old name',
        createdBy: creator.id,
        memberIds: [],
      });
      const updated = await renameConversation(db, conv.id, 'New name');
      expect(updated.title).toBe('New name');
    });
  });

  describe('addGroupMembers (CHAT-018)', () => {
    it('adds new members and reports only the ones actually added', async () => {
      const creator = await makeUser('add-a');
      const ben = await makeUser('add-b');
      const carl = await makeUser('add-c');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });

      // ben is already an active member -- only carl should come back as newly added.
      const added = await addGroupMembers(db, conv.id, [ben.id, carl.id]);
      expect(added).toEqual([carl.id]);
      expect(await countActiveMembers(db, conv.id)).toBe(3);
    });

    it('re-adding a previously removed member reactivates their row instead of erroring', async () => {
      const creator = await makeUser('readd-a');
      const ben = await makeUser('readd-b');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });
      await removeGroupMember(db, conv.id, ben.id);
      expect(await isConversationMember(db, conv.id, ben.id)).toBe(false);

      const added = await addGroupMembers(db, conv.id, [ben.id]);

      expect(added).toEqual([ben.id]);
      expect(await isConversationMember(db, conv.id, ben.id)).toBe(true);
      const membership = await getMembership(db, conv.id, ben.id);
      // Rejoins as a plain member, regardless of whatever role they had before leaving.
      expect(membership?.role).toBe('member');
    });

    it('returns an empty array when everyone given is already an active member', async () => {
      const creator = await makeUser('add-noop-a');
      const ben = await makeUser('add-noop-b');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });
      expect(await addGroupMembers(db, conv.id, [ben.id])).toEqual([]);
    });
  });

  describe('removeGroupMember (CHAT-018)', () => {
    it('sets leftAt and returns true; returns false for a non-member', async () => {
      const creator = await makeUser('remove-a');
      const ben = await makeUser('remove-b');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });

      expect(await removeGroupMember(db, conv.id, ben.id)).toBe(true);
      expect(await isConversationMember(db, conv.id, ben.id)).toBe(false);
      expect(await removeGroupMember(db, conv.id, ben.id)).toBe(false);
    });
  });

  describe('leaveConversation (CHAT-018)', () => {
    it('leaves without promoting anyone when the leaver was not the last admin', async () => {
      const creator = await makeUser('leave-a');
      const ben = await makeUser('leave-b');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });

      const result = await leaveConversation(db, conv.id, ben.id);

      expect(result).toEqual({ left: true, promotedUserId: null });
      expect(await isConversationMember(db, conv.id, ben.id)).toBe(false);
    });

    it('promotes the oldest remaining member when the last admin leaves', async () => {
      const creator = await makeUser('leave-c');
      const ben = await makeUser('leave-d');
      const carl = await makeUser('leave-e');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [],
      });
      // Added separately (not in the same createGroupConversation call) so their joinedAt values
      // are distinct and ordered: ben joined before carl.
      await addGroupMembers(db, conv.id, [ben.id]);
      await addGroupMembers(db, conv.id, [carl.id]);

      const result = await leaveConversation(db, conv.id, creator.id);

      expect(result.left).toBe(true);
      expect(result.promotedUserId).toBe(ben.id);
      expect((await getMembership(db, conv.id, ben.id))?.role).toBe('admin');
      expect((await getMembership(db, conv.id, carl.id))?.role).toBe('member');
    });

    it('does not promote anyone if another admin remains', async () => {
      const creator = await makeUser('leave-f');
      const ben = await makeUser('leave-g');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });
      await db
        .update(memberships)
        .set({ role: 'admin' })
        .where(and(eq(memberships.conversationId, conv.id), eq(memberships.userId, ben.id)));

      const result = await leaveConversation(db, conv.id, creator.id);

      expect(result).toEqual({ left: true, promotedUserId: null });
      expect((await getMembership(db, conv.id, ben.id))?.role).toBe('admin');
    });

    it('reports left: false for someone who already left / was never a member', async () => {
      const creator = await makeUser('leave-h');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [],
      });
      await leaveConversation(db, conv.id, creator.id);

      const result = await leaveConversation(db, conv.id, creator.id);
      expect(result).toEqual({ left: false, promotedUserId: null });
    });
  });

  describe('listActiveMembers (CHAT-018)', () => {
    it('lists only active members, oldest joined first, with their roles', async () => {
      const creator = await makeUser('list-members-a');
      const ben = await makeUser('list-members-b');
      const carl = await makeUser('list-members-c');
      const conv = await createGroupConversation(db, {
        title: 'g',
        createdBy: creator.id,
        memberIds: [ben.id],
      });
      await addGroupMembers(db, conv.id, [carl.id]);
      await removeGroupMember(db, conv.id, carl.id);

      const rows = await listActiveMembers(db, conv.id);

      expect(rows.map((r) => r.user.id)).toEqual([creator.id, ben.id]);
      expect(rows.find((r) => r.user.id === creator.id)?.role).toBe('admin');
      expect(rows.find((r) => r.user.id === ben.id)?.role).toBe('member');
    });
  });
});

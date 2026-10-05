import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/client.js';
import * as blocksDb from '../db/blocks.js';
import * as conversationsDb from '../db/conversations.js';
import * as messagesDb from '../db/messages.js';
import * as usersDb from '../db/users.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { S3Service } from '../storage/s3.service.js';
import { ConversationsService } from './conversations.service.js';

vi.mock('../db/blocks.js', () => ({
  hasBlockEitherDirection: vi.fn(),
  isBlocked: vi.fn(),
}));
vi.mock('../db/conversations.js', () => ({
  addGroupMembers: vi.fn(),
  countActiveMembers: vi.fn(),
  createGroupConversation: vi.fn(),
  findConversationForUser: vi.fn(),
  findOrCreateDirectConversation: vi.fn(),
  getMembership: vi.fn(),
  leaveConversation: vi.fn(),
  listActiveMembers: vi.fn(),
  listConversationsForUser: vi.fn(),
  markConversationRead: vi.fn(),
  markConversationUnread: vi.fn(),
  removeGroupMember: vi.fn(),
  renameConversation: vi.fn(),
}));
vi.mock('../db/messages.js', () => ({ appendMessage: vi.fn() }));
vi.mock('../db/users.js', () => ({ findUserById: vi.fn() }));

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    email: 'a@test.dev',
    username: 'annak',
    displayName: 'Anna',
    avatarKey: null,
    passwordHash: null,
    emailVerifiedAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastActiveAt: null,
    lastSeenVisibility: 'everyone' as const,
    readReceipts: true,
    notifyEnabled: true,
    notifySound: true,
    notifyPreviews: true,
    theme: 'system' as const,
    deletedAt: null,
    passwordChangedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeGroupRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-1',
    type: 'group' as const,
    title: 'The group',
    avatarKey: null,
    createdBy: 'user-1',
    directKey: null,
    lastSeq: 0,
    lastMessageAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    role: 'member' as const,
    lastReadSeq: 0,
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
    conversationId: 'conv-1',
    seq: 1,
    senderId: null,
    clientMsgId: null,
    type: 'system' as const,
    body: 'system message',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    meta: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ConversationsService (CHAT-018)', () => {
  let realtime: {
    addConversationForUser: ReturnType<typeof vi.fn>;
    removeConversationForUser: ReturnType<typeof vi.fn>;
    publishToConversation: ReturnType<typeof vi.fn>;
  };
  let s3: { getAvatarUrl: ReturnType<typeof vi.fn> };
  let service: ConversationsService;

  beforeEach(() => {
    vi.resetAllMocks();
    realtime = {
      addConversationForUser: vi.fn(),
      removeConversationForUser: vi.fn(),
      publishToConversation: vi.fn().mockResolvedValue(undefined),
    };
    s3 = { getAvatarUrl: vi.fn().mockResolvedValue(null) };
    vi.mocked(messagesDb.appendMessage).mockResolvedValue(makeMessageRow());
    vi.mocked(blocksDb.hasBlockEitherDirection).mockResolvedValue(false);
    vi.mocked(blocksDb.isBlocked).mockResolvedValue(false);
    service = new ConversationsService(
      {} as Database,
      s3 as unknown as S3Service,
      realtime as unknown as RealtimeService,
    );
  });

  describe('startDirect (CHAT-021 blocking)', () => {
    it('starts the conversation when there is no block either way', async () => {
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser({ id: 'user-2' }));
      vi.mocked(conversationsDb.findOrCreateDirectConversation).mockResolvedValue(
        makeGroupRow({ type: 'direct', directKey: 'user-1:user-2' }),
      );

      await service.startDirect('user-1', 'user-2');

      expect(conversationsDb.findOrCreateDirectConversation).toHaveBeenCalled();
    });

    it('404s (never a 403) when either side has blocked the other', async () => {
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser({ id: 'user-2' }));
      vi.mocked(blocksDb.hasBlockEitherDirection).mockResolvedValue(true);

      await expect(service.startDirect('user-1', 'user-2')).rejects.toThrow(NotFoundException);
      expect(conversationsDb.findOrCreateDirectConversation).not.toHaveBeenCalled();
    });
  });

  describe('createGroup', () => {
    it('creates the group, registers every member for realtime, and posts a "created the group" system message', async () => {
      vi.mocked(usersDb.findUserById).mockImplementation((_db, id) =>
        Promise.resolve(makeUser({ id, displayName: id === 'user-1' ? 'Anna' : 'Ben' })),
      );
      vi.mocked(conversationsDb.createGroupConversation).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );

      const result = await service.createGroup('user-1', 'Trip', ['user-2']);

      expect(result.type).toBe('group');
      expect(conversationsDb.createGroupConversation).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ createdBy: 'user-1', memberIds: ['user-2'] }),
      );
      expect(realtime.addConversationForUser).toHaveBeenCalledWith('user-1', 'conv-1');
      expect(realtime.addConversationForUser).toHaveBeenCalledWith('user-2', 'conv-1');
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ senderId: null, type: 'system', body: 'Anna created the group' }),
      );
      expect(realtime.publishToConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({ type: 'message.new' }),
      );
    });

    it('de-duplicates member ids and drops the creator if included', async () => {
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser());
      vi.mocked(conversationsDb.createGroupConversation).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );

      await service.createGroup('user-1', 'Trip', ['user-2', 'user-2', 'user-1']);

      expect(conversationsDb.createGroupConversation).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ memberIds: ['user-2'] }),
      );
    });

    it('rejects a group with no other members', async () => {
      await expect(service.createGroup('user-1', 'Trip', [])).rejects.toThrow(BadRequestException);
      expect(conversationsDb.createGroupConversation).not.toHaveBeenCalled();
    });

    it('rejects a group over the member cap', async () => {
      const memberIds = Array.from({ length: 100 }, (_, i) => `user-${i + 2}`);
      await expect(service.createGroup('user-1', 'Trip', memberIds)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s when a member id does not exist', async () => {
      vi.mocked(usersDb.findUserById).mockResolvedValue(undefined);
      await expect(service.createGroup('user-1', 'Trip', ['ghost'])).rejects.toThrow(
        NotFoundException,
      );
      expect(conversationsDb.createGroupConversation).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('renames as an admin and posts a system message', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser({ displayName: 'Anna' }));
      vi.mocked(conversationsDb.renameConversation).mockResolvedValue(
        makeGroupRow({ title: 'New name' }),
      );

      const result = await service.rename('conv-1', 'user-1', 'New name');

      expect(result.title).toBe('New name');
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ body: 'Anna renamed the group to "New name"' }),
      );
    });

    it('403s for a member who is not an admin', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'member' }),
      );
      await expect(service.rename('conv-1', 'user-1', 'New name')).rejects.toThrow(
        ForbiddenException,
      );
      expect(conversationsDb.renameConversation).not.toHaveBeenCalled();
    });

    it('404s for a non-member', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(undefined);
      await expect(service.rename('conv-1', 'user-1', 'New name')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects renaming a direct conversation', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ type: 'direct', role: 'admin' }),
      );
      await expect(service.rename('conv-1', 'user-1', 'New name')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('addMembers', () => {
    it('adds members within the cap and posts one combined system message', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(conversationsDb.countActiveMembers).mockResolvedValue(2);
      vi.mocked(usersDb.findUserById).mockImplementation((_db, id) => {
        const names: Record<string, string> = { 'user-1': 'Anna', ben: 'Ben', carl: 'Carl' };
        return Promise.resolve(makeUser({ id, displayName: names[id] ?? id }));
      });
      vi.mocked(conversationsDb.addGroupMembers).mockResolvedValue(['ben', 'carl']);

      await service.addMembers('conv-1', 'user-1', ['ben', 'carl']);

      expect(realtime.addConversationForUser).toHaveBeenCalledWith('ben', 'conv-1');
      expect(realtime.addConversationForUser).toHaveBeenCalledWith('carl', 'conv-1');
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ body: 'Anna added Ben and Carl' }),
      );
    });

    it('rejects when the total would exceed the member cap', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(conversationsDb.countActiveMembers).mockResolvedValue(99);

      await expect(service.addMembers('conv-1', 'user-1', ['ben', 'carl'])).rejects.toThrow(
        BadRequestException,
      );
      expect(conversationsDb.addGroupMembers).not.toHaveBeenCalled();
    });

    it('403s for a non-admin member', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'member' }),
      );
      await expect(service.addMembers('conv-1', 'user-1', ['ben'])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('skips the system message entirely when everyone given was already an active member', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(conversationsDb.countActiveMembers).mockResolvedValue(2);
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser({ id: 'ben' }));
      vi.mocked(conversationsDb.addGroupMembers).mockResolvedValue([]);

      await service.addMembers('conv-1', 'user-1', ['ben']);

      expect(messagesDb.appendMessage).not.toHaveBeenCalled();
    });

    it('CHAT-021: rejects adding someone who has blocked the actor', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(conversationsDb.countActiveMembers).mockResolvedValue(2);
      vi.mocked(usersDb.findUserById).mockImplementation((_db, id) =>
        Promise.resolve(makeUser({ id })),
      );
      vi.mocked(blocksDb.isBlocked).mockImplementation((_db, blockerId) =>
        Promise.resolve(blockerId === 'ben'),
      );

      await expect(service.addMembers('conv-1', 'user-1', ['ben', 'carl'])).rejects.toThrow(
        ForbiddenException,
      );
      expect(conversationsDb.addGroupMembers).not.toHaveBeenCalled();
    });
  });

  describe('removeMember', () => {
    it('removes a member as an admin, deregisters their realtime socket, and posts a system message', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(usersDb.findUserById).mockImplementation((_db, id) => {
        const names: Record<string, string> = { 'user-1': 'Anna', ben: 'Ben' };
        return Promise.resolve(makeUser({ id, displayName: names[id] ?? id }));
      });
      vi.mocked(conversationsDb.leaveConversation).mockResolvedValue({
        left: true,
        promotedUserId: null,
      });

      await service.removeMember('conv-1', 'user-1', 'ben');

      expect(realtime.removeConversationForUser).toHaveBeenCalledWith('ben', 'conv-1');
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ body: 'Anna removed Ben' }),
      );
    });

    it('403s for a non-admin', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'member' }),
      );
      await expect(service.removeMember('conv-1', 'user-1', 'ben')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects removing yourself (use leave instead)', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      await expect(service.removeMember('conv-1', 'user-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('404s when the target is not a member', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser({ id: 'ben' }));
      vi.mocked(conversationsDb.leaveConversation).mockResolvedValue({
        left: false,
        promotedUserId: null,
      });

      await expect(service.removeMember('conv-1', 'user-1', 'ben')).rejects.toThrow(
        NotFoundException,
      );
      expect(realtime.removeConversationForUser).not.toHaveBeenCalled();
    });

    it('announces a promotion when removing the last admin', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ role: 'admin' }),
      );
      vi.mocked(usersDb.findUserById).mockImplementation((_db, id) => {
        const names: Record<string, string> = { 'user-1': 'Anna', ben: 'Ben', carl: 'Carl' };
        return Promise.resolve(makeUser({ id, displayName: names[id] ?? id }));
      });
      vi.mocked(conversationsDb.leaveConversation).mockResolvedValue({
        left: true,
        promotedUserId: 'carl',
      });

      await service.removeMember('conv-1', 'user-1', 'ben');

      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ body: 'Carl is now an admin' }),
      );
    });
  });

  describe('leave', () => {
    it('lets any member leave without an admin check, and posts a system message', async () => {
      vi.mocked(conversationsDb.getMembership).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'member',
        lastReadSeq: 0,
        mutedUntil: null,
        joinedAt: new Date('2026-01-01T00:00:00Z'),
        leftAt: null,
      });
      vi.mocked(usersDb.findUserById).mockResolvedValue(makeUser({ displayName: 'Anna' }));
      vi.mocked(conversationsDb.leaveConversation).mockResolvedValue({
        left: true,
        promotedUserId: null,
      });

      await service.leave('conv-1', 'user-1');

      expect(realtime.removeConversationForUser).toHaveBeenCalledWith('user-1', 'conv-1');
      expect(messagesDb.appendMessage).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ body: 'Anna left' }),
      );
    });

    it('404s for a non-member', async () => {
      vi.mocked(conversationsDb.getMembership).mockResolvedValue(undefined);
      await expect(service.leave('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
      expect(conversationsDb.leaveConversation).not.toHaveBeenCalled();
    });

    it('AC: promotes the oldest remaining member and announces it when the last admin leaves', async () => {
      vi.mocked(conversationsDb.getMembership).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'admin',
        lastReadSeq: 0,
        mutedUntil: null,
        joinedAt: new Date('2026-01-01T00:00:00Z'),
        leftAt: null,
      });
      vi.mocked(usersDb.findUserById).mockImplementation((_db, id) => {
        const names: Record<string, string> = { 'user-1': 'Anna', ben: 'Ben' };
        return Promise.resolve(makeUser({ id, displayName: names[id] ?? id }));
      });
      vi.mocked(conversationsDb.leaveConversation).mockResolvedValue({
        left: true,
        promotedUserId: 'ben',
      });

      await service.leave('conv-1', 'user-1');

      expect(messagesDb.appendMessage).toHaveBeenNthCalledWith(
        1,
        {},
        expect.objectContaining({ body: 'Anna left' }),
      );
      expect(messagesDb.appendMessage).toHaveBeenNthCalledWith(
        2,
        {},
        expect.objectContaining({ body: 'Ben is now an admin' }),
      );
    });
  });

  describe('listMembers', () => {
    it('AC: returns each member with their role', async () => {
      vi.mocked(conversationsDb.getMembership).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'admin',
        lastReadSeq: 0,
        mutedUntil: null,
        joinedAt: new Date('2026-01-01T00:00:00Z'),
        leftAt: null,
      });
      vi.mocked(conversationsDb.listActiveMembers).mockResolvedValue([
        {
          user: makeUser({ id: 'user-1', displayName: 'Anna' }),
          role: 'admin',
          joinedAt: new Date('2026-01-01T00:00:00Z'),
          lastReadSeq: 5,
        },
        {
          user: makeUser({ id: 'ben', displayName: 'Ben' }),
          role: 'member',
          joinedAt: new Date('2026-01-02T00:00:00Z'),
          lastReadSeq: 3,
        },
      ]);

      const result = await service.listMembers('conv-1', 'user-1');

      expect(result).toEqual([
        expect.objectContaining({
          userId: 'user-1',
          displayName: 'Anna',
          role: 'admin',
          lastReadSeq: 5,
        }),
        expect.objectContaining({
          userId: 'ben',
          displayName: 'Ben',
          role: 'member',
          lastReadSeq: 3,
        }),
      ]);
    });

    it('404s for a non-member', async () => {
      vi.mocked(conversationsDb.getMembership).mockResolvedValue(undefined);
      await expect(service.listMembers('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('markRead (CHAT-019)', () => {
    it('advances lastReadSeq, clamps to lastSeq, and broadcasts to the whole conversation', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ type: 'direct', lastSeq: 5, lastReadSeq: 2 }),
      );
      vi.mocked(conversationsDb.markConversationRead).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'member',
        lastReadSeq: 5,
        mutedUntil: null,
        joinedAt: new Date('2026-01-01T00:00:00Z'),
        leftAt: null,
      });

      const result = await service.markRead('conv-1', 'user-1', 999); // way past lastSeq

      expect(conversationsDb.markConversationRead).toHaveBeenCalledWith({}, 'conv-1', 'user-1', 5);
      expect(result.lastReadSeq).toBe(5);
      expect(realtime.publishToConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          type: 'conversation.read',
          payload: { conversationId: 'conv-1', userId: 'user-1', lastReadSeq: 5 },
        }),
      );
    });

    it('does not broadcast when the seq does not actually advance anything', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ type: 'direct', lastSeq: 5, lastReadSeq: 5 }),
      );
      vi.mocked(conversationsDb.markConversationRead).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'member',
        lastReadSeq: 5,
        mutedUntil: null,
        joinedAt: new Date('2026-01-01T00:00:00Z'),
        leftAt: null,
      });

      await service.markRead('conv-1', 'user-1', 3);

      expect(realtime.publishToConversation).not.toHaveBeenCalled();
    });

    it('404s for a non-member', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(undefined);
      await expect(service.markRead('conv-1', 'user-1', 1)).rejects.toThrow(NotFoundException);
      expect(conversationsDb.markConversationRead).not.toHaveBeenCalled();
    });
  });

  describe('markUnread (CHAT-019)', () => {
    it('resets lastReadSeq to one less than lastSeq and broadcasts it', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ type: 'direct', lastSeq: 5, lastReadSeq: 5 }),
      );
      vi.mocked(conversationsDb.markConversationUnread).mockResolvedValue({
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'member',
        lastReadSeq: 4,
        mutedUntil: null,
        joinedAt: new Date('2026-01-01T00:00:00Z'),
        leftAt: null,
      });

      const result = await service.markUnread('conv-1', 'user-1');

      expect(conversationsDb.markConversationUnread).toHaveBeenCalledWith(
        {},
        'conv-1',
        'user-1',
        4,
      );
      expect(result.lastReadSeq).toBe(4);
      expect(realtime.publishToConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          type: 'conversation.read',
          payload: { conversationId: 'conv-1', userId: 'user-1', lastReadSeq: 4 },
        }),
      );
    });

    it('rejects a conversation with no messages yet', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(
        makeGroupRow({ type: 'direct', lastSeq: 0, lastReadSeq: 0 }),
      );

      await expect(service.markUnread('conv-1', 'user-1')).rejects.toThrow(BadRequestException);
      expect(conversationsDb.markConversationUnread).not.toHaveBeenCalled();
    });

    it('404s for a non-member', async () => {
      vi.mocked(conversationsDb.findConversationForUser).mockResolvedValue(undefined);
      await expect(service.markUnread('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });
});

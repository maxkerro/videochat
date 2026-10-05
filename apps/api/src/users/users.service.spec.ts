import { vi, type Mock } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';

vi.mock('../db/blocks.js', () => ({
  blockUser: vi.fn(),
  listBlockedUsers: vi.fn(),
  listBlockRelationshipUserIds: vi.fn(),
  unblockUser: vi.fn(),
}));
vi.mock('../db/users.js', () => ({
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  isUsernameTaken: vi.fn(),
  searchUsersByUsernamePrefix: vi.fn(),
  setAvatarKey: vi.fn(),
  updateProfile: vi.fn(),
}));

import * as blocksDb from '../db/blocks.js';
import * as usersDb from '../db/users.js';
import { UsersService } from './users.service.js';
import type { User } from '../db/schema.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'a@test.dev',
    username: 'alice',
    displayName: 'Alice',
    avatarKey: null,
    passwordHash: 'hashed:pw',
    emailVerifiedAt: new Date(),
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  const s3 = { getAvatarUrl: vi.fn().mockResolvedValue(null), putObject: vi.fn() };
  const avatars = { uploadAvatar: vi.fn() };
  const db = {} as never;
  const service = new UsersService(db, s3 as never, avatars as never);
  return { service, s3, avatars };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(blocksDb.listBlockRelationshipUserIds).mockResolvedValue(new Set());
});

describe('UsersService', () => {
  describe('getMe', () => {
    it('returns the mapped user', async () => {
      const user = makeUser();
      (usersDb.findUserById as Mock).mockResolvedValue(user);
      const { service } = makeService();
      const me = await service.getMe(user.id);
      expect(me.id).toBe(user.id);
      expect(me.username).toBe(user.username);
    });

    it('throws NotFoundException for an unknown user id', async () => {
      (usersDb.findUserById as Mock).mockResolvedValue(undefined);
      const { service } = makeService();
      await expect(service.getMe('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateProfile', () => {
    it('rejects a username that the availability check finds taken', async () => {
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(true);
      const { service } = makeService();
      await expect(service.updateProfile('user-1', { username: 'taken' })).rejects.toMatchObject({
        status: 409,
      });
      expect(usersDb.updateProfile).not.toHaveBeenCalled();
    });

    it('updates the profile when the username is free', async () => {
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(false);
      const updated = makeUser({ username: 'newname' });
      (usersDb.updateProfile as Mock).mockResolvedValue(updated);
      const { service } = makeService();
      const me = await service.updateProfile('user-1', { username: 'newname' });
      expect(me.username).toBe('newname');
    });

    it('maps a unique-constraint race on the write to a 409, not a 500', async () => {
      // The availability check passed, but a concurrent update to the same username won the
      // write first -- the unique index is what actually caught it.
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(false);
      (usersDb.updateProfile as Mock).mockRejectedValue({
        code: '23505',
        message: 'duplicate key',
      });
      const { service } = makeService();
      await expect(service.updateProfile('user-1', { username: 'racer' })).rejects.toMatchObject({
        status: 409,
      });
    });

    it('rethrows a non-unique-violation error from the write unchanged', async () => {
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(false);
      (usersDb.updateProfile as Mock).mockRejectedValue(new Error('connection reset'));
      const { service } = makeService();
      await expect(service.updateProfile('user-1', { username: 'x' })).rejects.toThrow(
        'connection reset',
      );
    });

    it('skips the availability check entirely when username is not part of the patch', async () => {
      (usersDb.updateProfile as Mock).mockResolvedValue(makeUser({ displayName: 'New Name' }));
      const { service } = makeService();
      const me = await service.updateProfile('user-1', { displayName: 'New Name' });
      expect(usersDb.isUsernameTaken).not.toHaveBeenCalled();
      expect(me.displayName).toBe('New Name');
    });
  });

  describe('isUsernameAvailable', () => {
    it('is the inverse of isUsernameTaken', async () => {
      (usersDb.isUsernameTaken as Mock).mockResolvedValue(true);
      const { service } = makeService();
      expect(await service.isUsernameAvailable('taken')).toBe(false);
    });
  });

  describe('uploadAvatar', () => {
    it('delegates to AvatarService, saves the key, and returns the mapped user', async () => {
      const { service, avatars } = makeService();
      avatars.uploadAvatar.mockResolvedValue('avatars/user-1');
      (usersDb.setAvatarKey as Mock).mockResolvedValue(makeUser({ avatarKey: 'avatars/user-1' }));
      const file = { buffer: Buffer.from('x'), mimetype: 'image/png', size: 1 };

      const me = await service.uploadAvatar('user-1', file);

      expect(avatars.uploadAvatar).toHaveBeenCalledWith('user-1', file);
      expect(usersDb.setAvatarKey).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'avatars/user-1',
      );
      expect(me.id).toBe('user-1');
    });
  });

  describe('searchUsers (CHAT-021)', () => {
    it('excludes anyone in a block relationship with the searcher from a username-prefix search', async () => {
      vi.mocked(blocksDb.listBlockRelationshipUserIds).mockResolvedValue(new Set(['blocked-1']));
      (usersDb.searchUsersByUsernamePrefix as Mock).mockResolvedValue([makeUser({ id: 'ben' })]);
      const { service } = makeService();

      await service.searchUsers('ben', 'user-1');

      expect(usersDb.searchUsersByUsernamePrefix).toHaveBeenCalledWith(
        expect.anything(),
        'ben',
        'user-1',
        expect.any(Number),
        ['blocked-1'],
      );
    });

    it('returns nothing for an exact-email match against someone in a block relationship', async () => {
      vi.mocked(blocksDb.listBlockRelationshipUserIds).mockResolvedValue(new Set(['blocked-1']));
      (usersDb.findUserByEmail as Mock).mockResolvedValue(makeUser({ id: 'blocked-1' }));
      const { service } = makeService();

      const results = await service.searchUsers('blocked@test.dev', 'user-1');

      expect(results).toEqual([]);
    });

    it('returns the exact-email match when there is no block relationship', async () => {
      vi.mocked(blocksDb.listBlockRelationshipUserIds).mockResolvedValue(new Set());
      (usersDb.findUserByEmail as Mock).mockResolvedValue(makeUser({ id: 'ben' }));
      const { service } = makeService();

      const results = await service.searchUsers('ben@test.dev', 'user-1');

      expect(results).toHaveLength(1);
    });
  });

  describe('blockUser (CHAT-021)', () => {
    it('rejects blocking yourself', async () => {
      const { service } = makeService();
      await expect(service.blockUser('user-1', 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(blocksDb.blockUser).not.toHaveBeenCalled();
    });

    it('404s for a target that does not exist', async () => {
      (usersDb.findUserById as Mock).mockResolvedValue(undefined);
      const { service } = makeService();
      await expect(service.blockUser('user-1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('records the block', async () => {
      (usersDb.findUserById as Mock).mockResolvedValue(makeUser({ id: 'ben' }));
      const { service } = makeService();
      await service.blockUser('user-1', 'ben');
      expect(blocksDb.blockUser).toHaveBeenCalledWith(expect.anything(), 'user-1', 'ben');
    });
  });

  describe('unblockUser (CHAT-021)', () => {
    it('removes the block without requiring one to have existed', async () => {
      const { service } = makeService();
      await service.unblockUser('user-1', 'ben');
      expect(blocksDb.unblockUser).toHaveBeenCalledWith(expect.anything(), 'user-1', 'ben');
    });
  });

  describe('listBlockedUsers (CHAT-021)', () => {
    it('maps each blocked user to the public shape', async () => {
      vi.mocked(blocksDb.listBlockedUsers).mockResolvedValue([
        { user: makeUser({ id: 'ben' }), createdAt: new Date() },
      ]);
      const { service } = makeService();

      const result = await service.listBlockedUsers('user-1');

      expect(result).toEqual([expect.objectContaining({ id: 'ben' })]);
    });
  });
});

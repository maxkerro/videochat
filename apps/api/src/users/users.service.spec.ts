import { vi, type Mock } from 'vitest';
import { NotFoundException } from '@nestjs/common';

vi.mock('../db/users.js', () => ({
  findUserById: vi.fn(),
  isUsernameTaken: vi.fn(),
  setAvatarKey: vi.fn(),
  updateProfile: vi.fn(),
}));

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

beforeEach(() => vi.clearAllMocks());

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
});

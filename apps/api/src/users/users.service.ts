import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LIMITS, type Me, type PublicUser, type UpdateProfileInput } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { DB } from '../infra/tokens.js';
import {
  findUserByEmail,
  findUserById,
  isUsernameTaken,
  searchUsersByUsernamePrefix,
  setAvatarKey,
  updateProfile,
} from '../db/users.js';
import { isUniqueViolation } from '../db/pg-errors.js';
import { S3Service } from '../storage/s3.service.js';
import { AvatarService, type UploadedAvatarFile } from './avatar.service.js';
import { toMe, toPublicUser } from './user-mapper.js';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly s3: S3Service,
    private readonly avatars: AvatarService,
  ) {}

  async getMe(userId: string): Promise<Me> {
    const user = await findUserById(this.db, userId);
    if (!user) throw new NotFoundException('User not found');
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
    return toMe(user, avatarUrl);
  }

  async updateProfile(userId: string, patch: UpdateProfileInput): Promise<Me> {
    if (patch.username && (await isUsernameTaken(this.db, patch.username, userId))) {
      throw new ConflictException('That username is already taken');
    }
    let user;
    try {
      user = await updateProfile(this.db, userId, patch);
    } catch (err) {
      // Same race as signup: the availability check above can't stop two concurrent updates to
      // the same username from both passing it and racing to the write.
      if (isUniqueViolation(err)) {
        throw new ConflictException('That username is already taken');
      }
      throw err;
    }
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
    return toMe(user, avatarUrl);
  }

  async isUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
    return !(await isUsernameTaken(this.db, username, excludeUserId));
  }

  /**
   * CHAT-012 "find people": a query containing "@" is treated as an exact email lookup (never
   * partial -- partial email matching would let one user enumerate others' addresses), anything
   * else as a username prefix search.
   */
  async searchUsers(query: string, excludeUserId: string): Promise<PublicUser[]> {
    if (query.includes('@')) {
      const user = await findUserByEmail(this.db, query);
      if (!user || user.id === excludeUserId) return [];
      const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
      return [toPublicUser(user, avatarUrl)];
    }

    const matches = await searchUsersByUsernamePrefix(
      this.db,
      query,
      excludeUserId,
      LIMITS.userSearchMaxResults,
    );
    return Promise.all(
      matches.map(async (user) => toPublicUser(user, await this.s3.getAvatarUrl(user.avatarKey))),
    );
  }

  async uploadAvatar(userId: string, file: UploadedAvatarFile): Promise<Me> {
    const key = await this.avatars.uploadAvatar(userId, file);
    const user = await setAvatarKey(this.db, userId, key);
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
    return toMe(user, avatarUrl);
  }
}

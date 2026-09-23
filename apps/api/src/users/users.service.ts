import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Me, UpdateProfileInput } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { DB } from '../infra/tokens.js';
import { findUserById, isUsernameTaken, setAvatarKey, updateProfile } from '../db/users.js';
import { S3Service } from '../storage/s3.service.js';
import { AvatarService, type UploadedAvatarFile } from './avatar.service.js';
import { toMe } from './user-mapper.js';

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
    const user = await updateProfile(this.db, userId, patch);
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
    return toMe(user, avatarUrl);
  }

  async isUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
    return !(await isUsernameTaken(this.db, username, excludeUserId));
  }

  async uploadAvatar(userId: string, file: UploadedAvatarFile): Promise<Me> {
    const key = await this.avatars.uploadAvatar(userId, file);
    const user = await setAvatarKey(this.db, userId, key);
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
    return toMe(user, avatarUrl);
  }
}

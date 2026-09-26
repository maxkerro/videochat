import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LIMITS, type Me, type PublicUser, type UpdateProfileInput } from '@videochat/shared';
import type { Database } from '../db/client.js';
import { DB } from '../infra/tokens.js';
import {
  blockUser,
  listBlockedUsers,
  listBlockRelationshipUserIds,
  unblockUser,
} from '../db/blocks.js';
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
   *
   * CHAT-021: "blocked users do not appear in search" -- applied from the searcher's own point of
   * view, excluding anyone in a block relationship with them either direction. Showing someone
   * who blocked the searcher (or whom the searcher blocked) defeats the point of either side of
   * that relationship, so this isn't just "people I've blocked".
   */
  async searchUsers(query: string, excludeUserId: string): Promise<PublicUser[]> {
    const blockRelationshipIds = await listBlockRelationshipUserIds(this.db, excludeUserId);

    if (query.includes('@')) {
      const user = await findUserByEmail(this.db, query);
      if (!user || user.id === excludeUserId || blockRelationshipIds.has(user.id)) return [];
      const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
      return [toPublicUser(user, avatarUrl)];
    }

    const matches = await searchUsersByUsernamePrefix(
      this.db,
      query,
      excludeUserId,
      LIMITS.userSearchMaxResults,
      Array.from(blockRelationshipIds),
    );
    return Promise.all(
      matches.map(async (user) => toPublicUser(user, await this.s3.getAvatarUrl(user.avatarKey))),
    );
  }

  /** CHAT-021: block someone -- from either a profile or a DM. Idempotent: blocking someone
   *  already blocked just confirms the state rather than erroring. "Blocking is silent to the
   *  blocked person" (AC) is enforced entirely by omission here -- this never notifies the target,
   *  posts a system message, or changes anything on their side of the conversation; see this
   *  story's write-up for the full list of what "silent" was decided to mean. */
  async blockUser(userId: string, targetId: string): Promise<void> {
    if (userId === targetId) throw new BadRequestException("Can't block yourself");
    const target = await findUserById(this.db, targetId);
    if (!target) throw new NotFoundException('User not found');
    await blockUser(this.db, userId, targetId);
  }

  /** CHAT-021: unblock. Also idempotent -- unblocking someone not currently blocked is a no-op,
   *  not a 404, matching `blockUser`'s own "this call ensures a state" framing. */
  async unblockUser(userId: string, targetId: string): Promise<void> {
    await unblockUser(this.db, userId, targetId);
  }

  /** CHAT-021: the caller's own blocklist ("view/manage a blocklist" from the story brief), most
   *  recently blocked first. */
  async listBlockedUsers(userId: string): Promise<PublicUser[]> {
    const rows = await listBlockedUsers(this.db, userId);
    return Promise.all(
      rows.map(async (row) =>
        toPublicUser(row.user, await this.s3.getAvatarUrl(row.user.avatarKey)),
      ),
    );
  }

  async uploadAvatar(userId: string, file: UploadedAvatarFile): Promise<Me> {
    const key = await this.avatars.uploadAvatar(userId, file);
    const user = await setAvatarKey(this.db, userId, key);
    const avatarUrl = await this.s3.getAvatarUrl(user.avatarKey);
    return toMe(user, avatarUrl);
  }
}

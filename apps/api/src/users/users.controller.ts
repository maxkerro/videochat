import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  LIMITS,
  updateProfileSchema,
  userSearchQuerySchema,
  usernameSchema,
  type BlockedUsersList,
  type Me,
  type UsernameAvailability,
  type UserSearchResults,
} from '@videochat/shared';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SearchThrottlerGuard } from '../rate-limit/rate-limit.guards.js';
import { UsersService } from './users.service.js';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @UseGuards(AccessTokenGuard)
  getMe(@CurrentUserId() userId: string): Promise<Me> {
    return this.users.getMe(userId);
  }

  @Patch('me')
  @UseGuards(AccessTokenGuard)
  updateMe(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: z.infer<typeof updateProfileSchema>,
  ): Promise<Me> {
    return this.users.updateProfile(userId, body);
  }

  /**
   * Public (no auth): used both while filling in the sign-up form (before a token exists) and
   * on the profile screen. Not a valid username shape is just "unavailable" rather than a 400,
   * since the caller is typically still mid-keystroke.
   */
  @Get('users/username-availability')
  async usernameAvailability(@Query('username') username?: string): Promise<UsernameAvailability> {
    if (!username || !usernameSchema.safeParse(username).success) {
      return { available: false };
    }
    return { available: await this.users.isUsernameAvailable(username) };
  }

  /** CHAT-012 "find people": username prefix or exact email, excluding the caller themselves
   *  (CHAT-021: and anyone in a block relationship with them). `SearchThrottlerGuard` runs after
   *  `AccessTokenGuard` (guards execute in the order listed) so it can track by user id. */
  @Get('users/search')
  @UseGuards(AccessTokenGuard, SearchThrottlerGuard)
  async searchUsers(
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(userSearchQuerySchema))
    query: z.infer<typeof userSearchQuerySchema>,
  ): Promise<UserSearchResults> {
    return { users: await this.users.searchUsers(query.q, userId) };
  }

  /** CHAT-021: everyone the caller has blocked ("view/manage a blocklist"). */
  @Get('users/blocked')
  @UseGuards(AccessTokenGuard)
  async listBlocked(@CurrentUserId() userId: string): Promise<BlockedUsersList> {
    return { users: await this.users.listBlockedUsers(userId) };
  }

  /** CHAT-021: block someone, from a profile or a DM. Idempotent -- see `UsersService.blockUser`. */
  @Post('users/:id/block')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async block(
    @CurrentUserId() userId: string,
    @Param('id', UuidParamPipe) targetId: string,
  ): Promise<{ message: string }> {
    await this.users.blockUser(userId, targetId);
    return { message: 'Blocked.' };
  }

  /** CHAT-021: unblock. Idempotent -- see `UsersService.unblockUser`. */
  @Delete('users/:id/block')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async unblock(
    @CurrentUserId() userId: string,
    @Param('id', UuidParamPipe) targetId: string,
  ): Promise<{ message: string }> {
    await this.users.unblockUser(userId, targetId);
    return { message: 'Unblocked.' };
  }

  @Post('me/avatar')
  @UseGuards(AccessTokenGuard)
  @UseInterceptors(
    FileInterceptor('avatar', {
      // In-memory buffer (not disk): sharp reads it directly and nothing lingers on disk.
      storage: memoryStorage(),
      // A generous margin over LIMITS.avatarMaxBytes -- the service's own check gives the
      // precise, user-facing error; this just stops multer from buffering something huge first.
      limits: { fileSize: LIMITS.avatarMaxBytes * 2 },
    }),
  )
  uploadAvatar(
    @CurrentUserId() userId: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<Me> {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.users.uploadAvatar(userId, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      size: file.size,
    });
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  usernameSchema,
  type Me,
  type UsernameAvailability,
} from '@videochat/shared';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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

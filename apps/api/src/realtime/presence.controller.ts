import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { presenceQuerySchema, type Presence } from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PresenceService } from './presence.service.js';

/** CHAT-034: who's online / when they were last seen, for people you share a conversation with. */
@Controller('presence')
@UseGuards(AccessTokenGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  get(
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(presenceQuerySchema)) query: z.infer<typeof presenceQuerySchema>,
  ): Promise<Presence[]> {
    return this.presence.getForViewer(userId, query.userIds);
  }
}

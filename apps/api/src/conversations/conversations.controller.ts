import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  startDirectConversationSchema,
  type ConversationSummary,
  type ConversationsList,
} from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ConversationsService } from './conversations.service.js';

@Controller('conversations')
@UseGuards(AccessTokenGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUserId() userId: string): Promise<ConversationsList> {
    return this.conversations.listForUser(userId);
  }

  @Post('direct')
  startDirect(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(startDirectConversationSchema))
    body: z.infer<typeof startDirectConversationSchema>,
  ): Promise<ConversationSummary> {
    return this.conversations.startDirect(userId, body.userId);
  }
}

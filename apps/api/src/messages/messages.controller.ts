import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { sendMessageSchema, type Message, type MessageList } from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MessagesService } from './messages.service.js';

@Controller('conversations/:conversationId/messages')
@UseGuards(AccessTokenGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
  ): Promise<MessageList> {
    return this.messages.listRecent(conversationId, userId);
  }

  @Post()
  send(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ): Promise<Message> {
    return this.messages.send(conversationId, userId, body);
  }
}

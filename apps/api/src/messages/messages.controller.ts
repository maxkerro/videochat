import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  editMessageSchema,
  messagesPageQuerySchema,
  sendMessageSchema,
  type Message,
  type MessagePage,
} from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UlidParamPipe } from '../common/ulid-param.pipe.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MessageThrottlerGuard } from '../rate-limit/rate-limit.guards.js';
import { MessagesService } from './messages.service.js';

@Controller('conversations/:conversationId/messages')
@UseGuards(AccessTokenGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(messagesPageQuerySchema))
    query: z.infer<typeof messagesPageQuerySchema>,
  ): Promise<MessagePage> {
    // CHAT-017: `after` is the gap-sync path (catching up post-reconnect); `before` is CHAT-016's
    // history paging. The schema's own refine() already rejects passing both.
    if (query.after !== undefined) {
      return this.messages.listAfter(conversationId, userId, query.after);
    }
    return this.messages.listPage(conversationId, userId, query.before);
  }

  /** CHAT-021: rate-limited per signed-in user ("more than 20 messages in 10s" -- see
   *  `MessageThrottlerGuard`). Runs after the class-level `AccessTokenGuard` (guards execute in
   *  the order they're declared -- class guards before method guards), so it can track by
   *  `req.user.sub`. */
  @Post()
  @UseGuards(MessageThrottlerGuard)
  send(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ): Promise<Message> {
    return this.messages.send(conversationId, userId, body);
  }

  /** CHAT-032: edit your own message's text, within the edit window. */
  @Patch(':messageId')
  @UseGuards(MessageThrottlerGuard)
  edit(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @Param('messageId', UlidParamPipe) messageId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(editMessageSchema)) body: z.infer<typeof editMessageSchema>,
  ): Promise<Message> {
    return this.messages.edit(conversationId, userId, messageId, body.body);
  }

  /** CHAT-032: delete for everyone -- the sender, or a group admin. Returns the tombstone. */
  @Delete(':messageId')
  delete(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @Param('messageId', UlidParamPipe) messageId: string,
    @CurrentUserId() userId: string,
  ): Promise<Message> {
    return this.messages.delete(conversationId, userId, messageId);
  }
}

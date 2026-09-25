import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  addMembersSchema,
  createGroupConversationSchema,
  renameConversationSchema,
  startDirectConversationSchema,
  type ConversationSummary,
  type ConversationsList,
  type MembersList,
} from '@videochat/shared';
import { z } from 'zod';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
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

  @Get(':conversationId')
  getOne(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
  ): Promise<ConversationSummary> {
    return this.conversations.getById(conversationId, userId);
  }

  @Post('direct')
  startDirect(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(startDirectConversationSchema))
    body: z.infer<typeof startDirectConversationSchema>,
  ): Promise<ConversationSummary> {
    return this.conversations.startDirect(userId, body.userId);
  }

  /** CHAT-018: `memberIds` is everyone other than the caller, who always becomes admin. */
  @Post('group')
  createGroup(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createGroupConversationSchema))
    body: z.infer<typeof createGroupConversationSchema>,
  ): Promise<ConversationSummary> {
    return this.conversations.createGroup(userId, body.title, body.memberIds);
  }

  /** CHAT-018: admin-only rename. */
  @Patch(':conversationId')
  rename(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(renameConversationSchema))
    body: z.infer<typeof renameConversationSchema>,
  ): Promise<ConversationSummary> {
    return this.conversations.rename(conversationId, userId, body.title);
  }

  /** CHAT-018: "members list shows roles" AC. */
  @Get(':conversationId/members')
  listMembers(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
  ): Promise<MembersList> {
    return this.conversations.listMembers(conversationId, userId);
  }

  /** CHAT-018: admin-only "add members". */
  @Post(':conversationId/members')
  addMembers(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(addMembersSchema)) body: z.infer<typeof addMembersSchema>,
  ): Promise<ConversationSummary> {
    return this.conversations.addMembers(conversationId, userId, body.memberIds);
  }

  /** CHAT-018: admin-only removal of someone else. */
  @Delete(':conversationId/members/:userId')
  removeMember(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @Param('userId', UuidParamPipe) targetUserId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    return this.conversations.removeMember(conversationId, userId, targetUserId);
  }

  /** CHAT-018: any member can leave; no admin check. */
  @Post(':conversationId/leave')
  leave(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    return this.conversations.leave(conversationId, userId);
  }
}

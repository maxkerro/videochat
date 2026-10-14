import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { ActiveGroupCallResponse, GroupCallJoin } from '@videochat/shared';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { GroupCallsService } from './group-calls.service.js';

@Controller('conversations/:conversationId/group-call')
@UseGuards(AccessTokenGuard)
export class GroupCallsController {
  constructor(private readonly groupCalls: GroupCallsService) {}

  /** CHAT-070: the call running in this group, if any (for the "Join" banner). */
  @Get()
  async running(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
  ): Promise<ActiveGroupCallResponse> {
    return { call: await this.groupCalls.running(conversationId, userId) };
  }

  /** CHAT-070: start the group's call, or join the running one. Returns a room token. */
  @Post()
  @HttpCode(200)
  join(
    @Param('conversationId', UuidParamPipe) conversationId: string,
    @CurrentUserId() userId: string,
  ): Promise<GroupCallJoin> {
    return this.groupCalls.join(conversationId, userId);
  }
}

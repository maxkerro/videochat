import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { callStatsSchema, type CallStats, type IceServersResponse } from '@videochat/shared';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { UuidParamPipe } from '../common/uuid-param.pipe.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CallStatsService } from './call-stats.service.js';
import { IceServersService } from './ice-servers.service.js';

@Controller('calls')
@UseGuards(AccessTokenGuard)
export class CallsController {
  constructor(
    private readonly iceServers: IceServersService,
    private readonly stats: CallStatsService,
  ) {}

  /** CHAT-040: STUN/TURN servers for the next call. Authenticated, so TURN credentials (which
   *  cost money to relay through) are only ever issued to signed-in users. */
  @Get('ice-servers')
  getIceServers(@CurrentUserId() userId: string): Promise<IceServersResponse> {
    return this.iceServers.forUser(userId);
  }

  /** CHAT-043: end-of-call quality summary from one participant's client. */
  @Post(':callId/stats')
  @HttpCode(204)
  async postStats(
    @Param('callId', UuidParamPipe) callId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(callStatsSchema)) body: CallStats,
  ): Promise<void> {
    await this.stats.record(userId, callId, body);
  }
}

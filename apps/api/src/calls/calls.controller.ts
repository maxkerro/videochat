import { Controller, Get, UseGuards } from '@nestjs/common';
import type { IceServersResponse } from '@videochat/shared';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard.js';
import { IceServersService } from './ice-servers.service.js';

@Controller('calls')
@UseGuards(AccessTokenGuard)
export class CallsController {
  constructor(private readonly iceServers: IceServersService) {}

  /** CHAT-040: STUN/TURN servers for the next call. Authenticated, so TURN credentials (which
   *  cost money to relay through) are only ever issued to signed-in users. */
  @Get('ice-servers')
  getIceServers(@CurrentUserId() userId: string): Promise<IceServersResponse> {
    return this.iceServers.forUser(userId);
  }
}

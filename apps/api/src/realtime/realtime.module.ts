import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PresenceController } from './presence.controller.js';
import { PresenceService } from './presence.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PresenceController],
  providers: [RealtimeGateway, RealtimeService, PresenceService],
  exports: [RealtimeService, PresenceService],
})
export class RealtimeModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { CallSignalingService } from './call-signaling.service.js';
import { CallsController } from './calls.controller.js';
import { IceServersService } from './ice-servers.service.js';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [CallsController],
  providers: [IceServersService, CallSignalingService],
  exports: [CallSignalingService],
})
export class CallsModule {}

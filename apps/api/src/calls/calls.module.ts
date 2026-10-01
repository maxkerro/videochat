import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { CallStatsService } from './call-stats.service.js';
import { CallSignalingService } from './call-signaling.service.js';
import { CallsController } from './calls.controller.js';
import { IceServersService } from './ice-servers.service.js';

@Module({
  imports: [AuthModule, RealtimeModule, MetricsModule],
  controllers: [CallsController],
  providers: [IceServersService, CallSignalingService, CallStatsService],
  exports: [CallSignalingService],
})
export class CallsModule {}

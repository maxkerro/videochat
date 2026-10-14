import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { GroupCallsController } from './group-calls.controller.js';
import { GroupCallsService } from './group-calls.service.js';
import { LiveKitSfu, SFU } from './sfu.js';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [GroupCallsController],
  providers: [{ provide: SFU, useClass: LiveKitSfu }, GroupCallsService],
})
export class GroupCallsModule {}

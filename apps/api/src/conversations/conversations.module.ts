import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GroupCallsModule } from '../group-calls/group-calls.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [AuthModule, RealtimeModule, GroupCallsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}

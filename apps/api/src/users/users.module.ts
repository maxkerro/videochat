import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AccountService } from './account.service.js';
import { AvatarService } from './avatar.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule, RealtimeModule, AttachmentsModule],
  controllers: [UsersController],
  providers: [UsersService, AvatarService, AccountService],
})
export class UsersModule {}

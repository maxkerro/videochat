import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { MessagesModule } from '../messages/messages.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ModerationController, UserReportsController } from './moderation.controller.js';
import { ModerationService } from './moderation.service.js';
import { ModeratorGuard } from './moderator.guard.js';

/** CHAT-077: reports of people, and the moderation console. */
@Module({
  imports: [AuthModule, MailModule, MessagesModule, RealtimeModule],
  controllers: [ModerationController, UserReportsController],
  providers: [ModerationService, ModeratorGuard],
})
export class ModerationModule {}

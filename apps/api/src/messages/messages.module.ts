import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { LinkPreviewsModule } from '../link-previews/link-previews.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { ReactionsService } from './reactions.service.js';

@Module({
  imports: [AuthModule, RealtimeModule, AttachmentsModule, LinkPreviewsModule, NotificationsModule],
  controllers: [MessagesController],
  providers: [MessagesService, ReactionsService],
})
export class MessagesModule {}

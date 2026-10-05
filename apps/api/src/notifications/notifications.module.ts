import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PUSH_CHANNELS } from './push-channel.js';
import { WebPushChannel } from './web-push.channel.js';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    WebPushChannel,
    // APNs / FCM channels (CHAT-055) get added to this list.
    {
      provide: PUSH_CHANNELS,
      useFactory: (web: WebPushChannel) => [web],
      inject: [WebPushChannel],
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

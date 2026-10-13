import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PUSH_CHANNELS } from './push-channel.js';
import { FcmPushChannel } from './fcm-push.channel.js';
import { WebPushChannel } from './web-push.channel.js';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    WebPushChannel,
    FcmPushChannel,
    // An APNs channel for iOS gets added to this list when there is an Apple developer account.
    {
      provide: PUSH_CHANNELS,
      useFactory: (web: WebPushChannel, fcm: FcmPushChannel) => [web, fcm],
      inject: [WebPushChannel, FcmPushChannel],
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

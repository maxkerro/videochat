import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { LinkPreviewsModule } from './link-previews/link-previews.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CallsModule } from './calls/calls.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra/infra.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { StorageModule } from './storage/storage.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    SentryModule.forRoot(),
    InfraModule,
    RateLimitModule,
    StorageModule,
    LoggingModule,
    MetricsModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ConversationsModule,
    RealtimeModule,
    AttachmentsModule,
    LinkPreviewsModule,
    NotificationsModule,
    MessagesModule,
    CallsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}

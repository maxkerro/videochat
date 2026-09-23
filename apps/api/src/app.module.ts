import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra/infra.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { MetricsModule } from './metrics/metrics.module.js';

@Module({
  imports: [
    SentryModule.forRoot(),
    InfraModule,
    LoggingModule,
    MetricsModule,
    HealthModule,
    // Feature modules (auth, users, conversations, messages, realtime) arrive in M1.
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}

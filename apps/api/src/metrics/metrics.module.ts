import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { MetricsController } from './metrics.controller.js';
import { MetricsMiddleware } from './metrics.middleware.js';
import { MetricsService } from './metrics.service.js';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MetricsMiddleware).forRoutes('*path');
  }
}

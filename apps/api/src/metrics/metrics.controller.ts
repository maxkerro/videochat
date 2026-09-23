import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  // Prometheus text exposition format. Protect this route at the edge (or with a token) in production.
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  get(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

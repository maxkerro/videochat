import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { HealthResponse } from '@videochat/shared';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness + dependency report. Always 200 while the process is serving requests,
   * so the platform doesn't restart the API just because Redis blipped.
   */
  @Get('health')
  @HttpCode(200)
  getHealth(): Promise<HealthResponse> {
    return this.health.check();
  }

  /** Readiness: 503 when a dependency is down, so load balancers stop routing traffic here. */
  @Get('ready')
  async getReady(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const result = await this.health.check();
    res.status(result.status === 'ok' ? 200 : 503);
    return result;
  }
}

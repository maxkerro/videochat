import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

const IGNORED = new Set(['/metrics', '/health', '/ready']);

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl.split('?')[0] ?? '';
    if (IGNORED.has(path)) return next();
    const end = this.metrics.httpDuration.startTimer();
    res.once('finish', () => {
      // Use the matched route pattern (/users/:id), never the raw path, to keep label cardinality low.
      const matched = (req.route as { path?: string } | undefined)?.path;
      const route = res.statusCode === 404 || !matched ? 'unmatched' : matched;
      const labels = { method: req.method, route, status: String(res.statusCode) };
      end(labels);
      if (res.statusCode >= 500) this.metrics.httpErrors.inc({ method: req.method, route });
    });
    next();
  }
}

import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { MetricsMiddleware } from './metrics.middleware.js';
import type { MetricsService } from './metrics.service.js';

function makeMetrics() {
  const end = vi.fn();
  return {
    httpDuration: { startTimer: vi.fn().mockReturnValue(end) },
    httpErrors: { inc: vi.fn() },
    end,
  };
}

function makeReqRes(originalUrl: string, method = 'GET') {
  const req = { originalUrl, method, route: undefined } as unknown as Request;
  const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as Response;
  return { req, res: res as Response & EventEmitter };
}

describe('MetricsMiddleware', () => {
  it('skips timing for ignored paths (/health, /ready, /metrics)', () => {
    const metrics = makeMetrics();
    const middleware = new MetricsMiddleware(metrics as unknown as MetricsService);
    const { req, res } = makeReqRes('/health');
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(metrics.httpDuration.startTimer).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('strips the query string before matching ignored paths', () => {
    const metrics = makeMetrics();
    const middleware = new MetricsMiddleware(metrics as unknown as MetricsService);
    const { req, res } = makeReqRes('/metrics?foo=bar');
    middleware.use(req, res, vi.fn());
    expect(metrics.httpDuration.startTimer).not.toHaveBeenCalled();
  });

  it('labels a 404 or an unmatched route as "unmatched"', () => {
    const metrics = makeMetrics();
    const middleware = new MetricsMiddleware(metrics as unknown as MetricsService);
    const { req, res } = makeReqRes('/does-not-exist');
    res.statusCode = 404;

    middleware.use(req, res, vi.fn());
    res.emit('finish');

    expect(metrics.end).toHaveBeenCalledWith({
      method: 'GET',
      route: 'unmatched',
      status: '404',
    });
  });

  it('labels a matched route by its route pattern, not the raw path', () => {
    const metrics = makeMetrics();
    const middleware = new MetricsMiddleware(metrics as unknown as MetricsService);
    const { req, res } = makeReqRes('/conversations/abc-123');
    (req as unknown as { route: { path: string } }).route = { path: '/conversations/:id' };
    res.statusCode = 200;

    middleware.use(req, res, vi.fn());
    res.emit('finish');

    expect(metrics.end).toHaveBeenCalledWith({
      method: 'GET',
      route: '/conversations/:id',
      status: '200',
    });
  });

  it('counts a 5xx response as an error', () => {
    const metrics = makeMetrics();
    const middleware = new MetricsMiddleware(metrics as unknown as MetricsService);
    const { req, res } = makeReqRes('/boom');
    res.statusCode = 500;

    middleware.use(req, res, vi.fn());
    res.emit('finish');

    expect(metrics.httpErrors.inc).toHaveBeenCalledWith({ method: 'GET', route: 'unmatched' });
  });

  it('does not count a successful response as an error', () => {
    const metrics = makeMetrics();
    const middleware = new MetricsMiddleware(metrics as unknown as MetricsService);
    const { req, res } = makeReqRes('/ok');
    (req as unknown as { route: { path: string } }).route = { path: '/ok' };
    res.statusCode = 200;

    middleware.use(req, res, vi.fn());
    res.emit('finish');

    expect(metrics.httpErrors.inc).not.toHaveBeenCalled();
  });
});

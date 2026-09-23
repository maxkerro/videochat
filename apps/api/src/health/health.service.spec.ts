import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Env } from '../config/env.js';
import { HealthService } from './health.service.js';

const env = { APP_VERSION: 'test-sha' } as Env;

function makeService(opts: { db: boolean; redis: boolean }) {
  const pool = {
    query: opts.db ? vi.fn().mockResolvedValue({}) : vi.fn().mockRejectedValue(new Error('down')),
  } as unknown as pg.Pool;
  const redis = {
    ping: opts.redis
      ? vi.fn().mockResolvedValue('PONG')
      : vi.fn().mockRejectedValue(new Error('down')),
  } as unknown as Redis;
  return new HealthService(pool, redis, env);
}

describe('HealthService', () => {
  it('is ok when every dependency is up', async () => {
    const result = await makeService({ db: true, redis: true }).check();
    expect(result).toMatchObject({
      status: 'ok',
      version: 'test-sha',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('is degraded and names the failing dependency', async () => {
    const result = await makeService({ db: true, redis: false }).check();
    expect(result.status).toBe('degraded');
    expect(result.checks).toEqual({ database: 'up', redis: 'down' });
  });
});

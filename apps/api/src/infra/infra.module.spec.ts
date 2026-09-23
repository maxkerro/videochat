import type { Redis } from 'ioredis';
import type pg from 'pg';
import { InfraModule } from './infra.module.js';

describe('InfraModule', () => {
  it('connects to Redis on init, tolerating it being briefly unreachable', async () => {
    const pool = {} as pg.Pool;
    const redis = { connect: vi.fn().mockRejectedValue(new Error('down')) } as unknown as Redis;
    const module = new InfraModule(pool, redis);

    await expect(module.onModuleInit()).resolves.toBeUndefined();
    expect(redis.connect).toHaveBeenCalledOnce();
  });

  it('closes the Postgres pool and Redis connection on shutdown, for a clean rolling-deploy drain', async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as pg.Pool;
    const redis = { quit: vi.fn().mockResolvedValue('OK') } as unknown as Redis;
    const module = new InfraModule(pool, redis);

    await module.onApplicationShutdown();

    expect(pool.end).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it('closes whichever connection still succeeds even if the other fails', async () => {
    const pool = {
      end: vi.fn().mockRejectedValue(new Error('pool already closed')),
    } as unknown as pg.Pool;
    const redis = { quit: vi.fn().mockResolvedValue('OK') } as unknown as Redis;
    const module = new InfraModule(pool, redis);

    await expect(module.onApplicationShutdown()).resolves.toBeUndefined();
    expect(redis.quit).toHaveBeenCalledOnce();
  });
});

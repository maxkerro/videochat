import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { loadEnv, type Env } from '../config/env.js';
import { createDb, createPool } from '../db/client.js';
import { DB, ENV, PG_POOL, REDIS } from './tokens.js';

/**
 * Provides validated config, the Postgres pool, the Drizzle client and Redis to the whole app.
 * Connections are closed on shutdown so rolling deploys drain cleanly.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) => createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX),
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: pg.Pool) => createDb(pool) },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Redis(env.REDIS_URL, {
          // Fail readiness checks quickly instead of queueing commands while Redis is down.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 3_000,
          // Connected explicitly in onModuleInit so the app is ready once boot finishes.
          lazyConnect: true,
        }),
    },
  ],
  exports: [ENV, PG_POOL, DB, REDIS],
})
export class InfraModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(InfraModule.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Don't crash on boot if Redis is briefly unavailable: /ready reports it and ioredis keeps retrying.
    await this.redis.connect().catch((err: Error) => {
      this.logger.warn(`Redis not reachable at startup: ${err.message}`);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

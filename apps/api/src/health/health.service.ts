import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@videochat/shared';
import { Redis } from 'ioredis';
import type pg from 'pg';
import type { Env } from '../config/env.js';
import { ENV, PG_POOL, REDIS } from '../infra/tokens.js';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.probe(() => this.pool.query('SELECT 1')),
      this.probe(() => this.redis.ping()),
    ]);
    const checks = { database, redis };
    return {
      status: Object.values(checks).every((s) => s === 'up') ? 'ok' : 'degraded',
      version: this.env.APP_VERSION,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  private async probe(fn: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await withTimeout(fn(), CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }
}

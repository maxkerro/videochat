import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';
import { buildRateLimiters } from './rate-limit.config.js';
import {
  LoginThrottlerGuard,
  MessageThrottlerGuard,
  SearchThrottlerGuard,
} from './rate-limit.guards.js';

/**
 * CHAT-021: server-side rate limits for login, search and message sending, each independently
 * configurable via env vars (see `config/env.ts`) with no code change or rebuild needed to change
 * a threshold. `@Global` (matching `InfraModule`'s own pattern) so any feature module can attach
 * one of the three guards below to a route without importing this module explicitly.
 *
 * Storage is `@nestjs/throttler`'s default in-memory counter, not the Redis client `InfraModule`
 * already provides -- fine for this app's single-instance local/staging setup, but worth flagging
 * for a multi-instance production deployment: each instance would enforce its own separate
 * counters, so the *effective* limit across N instances is N times the configured one. Wiring in
 * `@nestjs/throttler-storage-redis` against the existing Redis connection would fix that, and is
 * a natural follow-up if/when the API runs behind more than one instance.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ throttlers: buildRateLimiters(env) }),
    }),
  ],
  providers: [LoginThrottlerGuard, SearchThrottlerGuard, MessageThrottlerGuard],
  exports: [LoginThrottlerGuard, SearchThrottlerGuard, MessageThrottlerGuard],
})
export class RateLimitModule {}

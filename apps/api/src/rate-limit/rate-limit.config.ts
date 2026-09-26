import type { ThrottlerOptions } from '@nestjs/throttler';
import type { Env } from '../config/env.js';

/**
 * CHAT-021: builds the three named rate limiters (login, search, message sending) from env, so
 * a threshold can be changed with an env var and a restart -- no code change or rebuild (the AC's
 * "configurable without a deploy"). Kept as a small pure function, separate from
 * `RateLimitModule`'s `ThrottlerModule.forRootAsync` wiring, so it can be unit-tested without
 * spinning up Nest's DI container at all.
 *
 * `ttl` is milliseconds (`@nestjs/throttler`'s own unit); the env vars are seconds, which reads
 * more naturally in an `.env` file ("10 seconds" vs "10000").
 */
export function buildRateLimiters(env: Env): ThrottlerOptions[] {
  return [
    { name: 'login', limit: env.RATE_LIMIT_LOGIN_MAX, ttl: env.RATE_LIMIT_LOGIN_WINDOW_SEC * 1000 },
    {
      name: 'search',
      limit: env.RATE_LIMIT_SEARCH_MAX,
      ttl: env.RATE_LIMIT_SEARCH_WINDOW_SEC * 1000,
    },
    {
      name: 'messages',
      limit: env.RATE_LIMIT_MESSAGES_MAX,
      ttl: env.RATE_LIMIT_MESSAGES_WINDOW_SEC * 1000,
    },
  ];
}

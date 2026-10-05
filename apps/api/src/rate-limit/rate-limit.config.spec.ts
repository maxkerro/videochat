import type { Env } from '../config/env.js';
import { buildRateLimiters } from './rate-limit.config.js';

/** Only the fields `buildRateLimiters` reads -- the rest of `Env` is irrelevant here. */
function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RATE_LIMIT_LOGIN_MAX: 10,
    RATE_LIMIT_LOGIN_WINDOW_SEC: 60,
    RATE_LIMIT_SEARCH_MAX: 30,
    RATE_LIMIT_SEARCH_WINDOW_SEC: 10,
    RATE_LIMIT_MESSAGES_MAX: 20,
    RATE_LIMIT_MESSAGES_WINDOW_SEC: 10,
    RATE_LIMIT_EXPORT_MAX: 5,
    RATE_LIMIT_EXPORT_WINDOW_SEC: 3600,
    ...overrides,
  } as Env;
}

describe('buildRateLimiters', () => {
  it('produces one named entry per limiter, using the env-configured defaults', () => {
    const limiters = buildRateLimiters(fakeEnv());
    expect(limiters).toEqual([
      { name: 'login', limit: 10, ttl: 60_000 },
      { name: 'search', limit: 30, ttl: 10_000 },
      { name: 'messages', limit: 20, ttl: 10_000 },
      { name: 'export', limit: 5, ttl: 3_600_000 },
    ]);
  });

  it('is configurable without a deploy: a changed env value changes the built limiter', () => {
    // AC: "Rate limits are configurable without a deploy" -- this is what makes that true. There
    // is no other place a threshold is hardcoded; changing `RATE_LIMIT_MESSAGES_MAX` and
    // restarting the process is the whole story.
    const limiters = buildRateLimiters(
      fakeEnv({ RATE_LIMIT_MESSAGES_MAX: 5, RATE_LIMIT_MESSAGES_WINDOW_SEC: 2 }),
    );
    const messages = limiters.find((l) => l.name === 'messages');
    expect(messages).toEqual({ name: 'messages', limit: 5, ttl: 2_000 });
  });

  it('converts each *_WINDOW_SEC env var to milliseconds for ttl', () => {
    const limiters = buildRateLimiters(fakeEnv({ RATE_LIMIT_LOGIN_WINDOW_SEC: 90 }));
    expect(limiters.find((l) => l.name === 'login')?.ttl).toBe(90_000);
  });
});

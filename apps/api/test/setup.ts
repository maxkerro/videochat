import { existsSync } from 'node:fs';

// Tests never touch the development database: point DATABASE_URL at TEST_DATABASE_URL.
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'warn';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// CHAT-021: rate limiting is real here (see RateLimitModule), but an e2e/int spec file reuses one
// Nest app instance across many requests from the same IP/user in quick succession -- exactly
// what the limiter exists to catch, and unrelated to whatever that spec is actually testing.
// Generous test-only defaults keep ordinary test traffic from tripping it; the limiter's own
// behavior (a low threshold actually triggering, with the right error) is covered directly
// against the guard in rate-limit.guards.spec.ts, not through a live app.
process.env.RATE_LIMIT_LOGIN_MAX ??= '1000';
process.env.RATE_LIMIT_SEARCH_MAX ??= '1000';
process.env.RATE_LIMIT_MESSAGES_MAX ??= '1000';
process.env.RATE_LIMIT_EXPORT_MAX ??= '1000';

// Each e2e/int spec file boots its own full Nest app (its own real Postgres pool, up to
// DATABASE_POOL_MAX connections), and with fileParallelism: false they all run sequentially in
// one process -- so if any one file's app.close() doesn't fully release its pool before the next
// file's beforeAll opens a new one (a slow shutdown, not necessarily a real leak), open
// connections can stack up across the run instead of staying bounded to one file's worth.
// A handful of e2e requests at a time never needs the production default of 10; capping it here
// keeps the worst case (every currently-running file's pool still open at once) far below
// Postgres's own default max_connections (100), so this class of failure can't happen from the
// test suite's own connection count, whatever turns out to cause any single slow teardown.
process.env.DATABASE_POOL_MAX ??= '4';

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

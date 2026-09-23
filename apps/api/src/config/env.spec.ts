import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('applies defaults and parses CORS origins', () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('treats empty optional URLs as unset', () => {
    const env = loadEnv({ ...base, SENTRY_DSN: '', OTEL_EXPORTER_OTLP_ENDPOINT: '' });
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('accepts a real value for an optional URL', () => {
    const env = loadEnv({ ...base, SENTRY_DSN: 'https://key@sentry.example/1' });
    expect(env.SENTRY_DSN).toBe('https://key@sentry.example/1');
  });

  it('fails fast with a readable message when required values are missing', () => {
    expect(() => loadEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('caches the result for process.env, so a second call skips re-parsing', () => {
    const originalEnv = { ...process.env };
    try {
      Object.assign(process.env, base, { APP_VERSION: 'cache-test' });
      const first = loadEnv();
      process.env.APP_VERSION = 'changed-after-cache';
      const second = loadEnv();
      expect(second).toBe(first);
      expect(second.APP_VERSION).toBe('cache-test');
    } finally {
      process.env = originalEnv;
    }
  });
});

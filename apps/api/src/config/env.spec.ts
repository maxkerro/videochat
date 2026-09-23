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

  it('fails fast with a readable message when required values are missing', () => {
    expect(() => loadEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
  });
});

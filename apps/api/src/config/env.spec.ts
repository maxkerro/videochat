import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(32),
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

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });

  it('treats the literal string "false" as false for a stringbool flag, unlike z.coerce.boolean', () => {
    const env = loadEnv({ ...base, S3_FORCE_PATH_STYLE: 'false' });
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('rejects localhost defaults for PUBLIC_WEB_URL, SMTP_URL and S3_* in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /PUBLIC_WEB_URL.*production/s,
    );
  });

  it('accepts production when the localhost defaults are overridden with real values', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_WEB_URL: 'https://videochat-web.onrender.com',
      SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_BUCKET: 'videochat-prod',
      S3_ACCESS_KEY_ID: 'real-key',
      S3_SECRET_ACCESS_KEY: 'real-secret',
    });
    expect(env.PUBLIC_WEB_URL).toBe('https://videochat-web.onrender.com');
  });

  it('does not require production values outside production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(env.PUBLIC_WEB_URL).toBe('http://localhost:5173');
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
  describe('TURN (CHAT-040)', () => {
    it('defaults to public STUN and no TURN provider', () => {
      const env = loadEnv(base);
      expect(env.STUN_URLS).toEqual(['stun:stun.l.google.com:19302']);
      expect(env.TURN_PROVIDER).toBe('none');
      expect(env.TURN_TTL_SEC).toBe(3600);
    });

    it('parses comma-separated STUN/TURN URL lists', () => {
      const env = loadEnv({
        ...base,
        STUN_URLS: 'stun:a.test:3478, stun:b.test:3478',
        TURN_PROVIDER: 'hmac',
        TURN_URLS: 'turn:t.test:3478,turns:t.test:443?transport=tcp',
        TURN_SECRET: 's'.repeat(16),
      });
      expect(env.STUN_URLS).toEqual(['stun:a.test:3478', 'stun:b.test:3478']);
      expect(env.TURN_URLS).toEqual(['turn:t.test:3478', 'turns:t.test:443?transport=tcp']);
    });

    it('fails fast when hmac is selected without URLs or a long enough secret', () => {
      expect(() => loadEnv({ ...base, TURN_PROVIDER: 'hmac' })).toThrow(/TURN_URLS.*TURN_SECRET/s);
    });

    it('fails fast when cloudflare is selected without its key id and token', () => {
      expect(() => loadEnv({ ...base, TURN_PROVIDER: 'cloudflare' })).toThrow(
        /CLOUDFLARE_TURN_KEY_ID.*CLOUDFLARE_TURN_API_TOKEN/s,
      );
    });

    it('rejects an unknown provider', () => {
      expect(() => loadEnv({ ...base, TURN_PROVIDER: 'twilio' })).toThrow(/TURN_PROVIDER/);
    });
  });
});

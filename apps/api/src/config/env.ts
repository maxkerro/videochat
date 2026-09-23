import { existsSync } from 'node:fs';
import { z } from 'zod';

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v : undefined))
  .pipe(z.url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url(),
  SENTRY_DSN: optionalUrl,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  OTEL_SERVICE_NAME: z.string().default('videochat-api'),
  /** Git commit shown in /health. Falls back to Render's RENDER_GIT_COMMIT (see loadEnv). */
  APP_VERSION: z.string().default('dev'),

  // --- Auth (CHAT-010) ---
  /** Signs access tokens. Must be at least 32 chars; rotate it to invalidate every access token at once. */
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Base URL of the web app, used to build links in verification/reset emails. */
  PUBLIC_WEB_URL: z.url().default('http://localhost:5173'),

  // --- Email (Mailpit locally; any SMTP server in production) ---
  SMTP_URL: z.url().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('Videochat <no-reply@videochat.local>'),

  // --- Object storage (MinIO locally, S3/R2 in the cloud) ---
  S3_ENDPOINT: z.url().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('videochat-uploads'),
  S3_ACCESS_KEY_ID: z.string().default('videochat'),
  S3_SECRET_ACCESS_KEY: z.string().default('videochat-secret'),
  /** MinIO needs path-style URLs (http://host:9000/bucket/key); a real S3/R2 bucket usually doesn't.
   *  z.stringbool(), not z.coerce.boolean(): coerce would make the literal string "false" truthy. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Loads `.env` (outside production) and validates the environment once.
 * Fails fast at startup with a readable list of what is missing or wrong.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  if (source === process.env && source.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const parsed = envSchema.safeParse({
    ...source,
    APP_VERSION: source.APP_VERSION ?? source.RENDER_GIT_COMMIT,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

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

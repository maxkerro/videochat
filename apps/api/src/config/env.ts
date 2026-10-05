import { existsSync } from 'node:fs';
import { z } from 'zod';

/** Comma-separated list -> trimmed, non-empty entries. */
function splitList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v : undefined))
  .pipe(z.url().optional());

/** Fields that default to a local dev value and must be set explicitly in production,
 *  otherwise the app "succeeds" while silently doing the wrong thing (mail never sends,
 *  avatars never persist, verification links point at localhost). */
const requiredInProduction = [
  'PUBLIC_WEB_URL',
  'SMTP_URL',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

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

  // --- Reverse proxy (review follow-up to CHAT-021) ---
  /** Number of reverse-proxy hops in front of this process. Render puts exactly one in front of
   *  every request; Express's `trust proxy` (set from this in `configureApp`) needs that hop
   *  count to trust and parse `X-Forwarded-For`, otherwise `req.ip` -- and with it every
   *  IP-tracked rate limit below -- resolves to the proxy's own address for every client, not the
   *  real caller's. Default of 1 matches Render/production; a bare local process with no proxy in
   *  front (or a test harness talking to the app directly) should set this to 0. */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),

  // --- Rate limiting (CHAT-021) ---
  // AC: "configurable without a deploy" -- these are read at boot (see RateLimitModule), so
  // changing one and restarting the process is enough; no code change or rebuild needed. Each
  // pair is a request cap and the rolling window (seconds) it applies over.
  // --- Calls: STUN/TURN (CHAT-040) ---
  /** Comma-separated STUN URLs handed to every client. Free public STUN is enough for most home
   *  networks; set to an empty string to hand out none. */
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302').transform(splitList),
  /** Where TURN relay credentials come from:
   *   - `none`: STUN only. Calls still connect on most networks, but not behind strict NATs or
   *     UDP-blocking firewalls (roughly 10-20% of calls in practice).
   *   - `hmac`: coturn's `use-auth-secret` scheme (also supported by most managed TURN services):
   *     credentials are derived locally from TURN_SECRET, no network call.
   *   - `cloudflare`: Cloudflare Realtime TURN; credentials are minted per call through its API. */
  TURN_PROVIDER: z.enum(['none', 'hmac', 'cloudflare']).default('none'),
  /** `hmac` only: comma-separated TURN URLs, e.g. `turn:turn.example.com:3478?transport=udp,
   *  turns:turn.example.com:443?transport=tcp` (the TLS-on-443 entry is what gets through
   *  firewalls that block UDP). */
  TURN_URLS: z.string().default('').transform(splitList),
  /** `hmac` only: the shared secret configured as coturn's `static-auth-secret`. */
  TURN_SECRET: z.string().default(''),
  /** How long an issued TURN credential stays valid. The AC's 1 h by default. */
  TURN_TTL_SEC: z.coerce.number().int().positive().max(86_400).default(3_600),
  /** `cloudflare` only: the TURN key id and its API token, from the Cloudflare dashboard. */
  CLOUDFLARE_TURN_KEY_ID: z.string().default(''),
  CLOUDFLARE_TURN_API_TOKEN: z.string().default(''),

  // --- Calls: signalling (CHAT-041) ---
  /** An unanswered call stops ringing and is logged as missed after this long (the AC's 30 s). */
  CALL_RING_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  /** How long a participant whose connection dropped mid-call has to reconnect before the call
   *  is ended (CHAT-043). A little longer than the client's 15 s "Reconnecting..." overlay, so the
   *  client always gives up first and the server never ends a call the client still shows. */
  CALL_RECONNECT_GRACE_SEC: z.coerce.number().int().positive().default(20),

  // --- Web push (CHAT-035) ---
  /** VAPID keys identifying this server to browser push services. Generate a pair once with
   *  `npx web-push generate-vapid-keys`. Unset = push notifications off (in-app still works). */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  /** Contact for push services, `mailto:` or an https URL. */
  VAPID_SUBJECT: z.string().default('mailto:admin@videochat.local'),

  /** Login attempts, tracked per client IP (there's no authenticated user yet at this endpoint).
   *  Distinct from CHAT-010's per-account lockout after 5 *failed* attempts -- this limits the
   *  *rate* of attempts against the endpoint itself, successful or not, and by IP rather than by
   *  account, so it also covers someone trying many different accounts' emails. Both run; neither
   *  replaces the other. */
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  /** "Find people" search, tracked per authenticated user. */
  RATE_LIMIT_SEARCH_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_SEARCH_WINDOW_SEC: z.coerce.number().int().positive().default(10),
  /** Message sending, tracked per authenticated user. Defaults match the AC's own example
   *  ("more than 20 messages in 10 seconds"). */
  RATE_LIMIT_MESSAGES_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_MESSAGES_WINDOW_SEC: z.coerce.number().int().positive().default(10),
});

const envSchemaWithProductionChecks = envSchema.superRefine((data, ctx) => {
  // A TURN provider that's selected but not configured would otherwise only show up as calls
  // silently failing behind strict NATs, so it fails at startup instead, in every environment.
  if (data.TURN_PROVIDER === 'hmac') {
    if (data.TURN_URLS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_URLS'],
        message: 'required when TURN_PROVIDER=hmac',
      });
    }
    if (data.TURN_SECRET.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_SECRET'],
        message: 'must be at least 16 characters when TURN_PROVIDER=hmac',
      });
    }
  }
  if (data.TURN_PROVIDER === 'cloudflare') {
    for (const key of ['CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN'] as const) {
      if (data[key] === '') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when TURN_PROVIDER=cloudflare',
        });
      }
    }
  }
  if (data.NODE_ENV !== 'production') return;
  for (const key of requiredInProduction) {
    // These vars are actual localhost defaults in envSchema. z.url() still passes for
    // "http://localhost:9000", so we have to check the raw value, not just presence.
    if (data[key].includes('localhost')) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must be set explicitly in production (it is still at its local dev default)`,
      });
    }
  }
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
  const parsed = envSchemaWithProductionChecks.safeParse({
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

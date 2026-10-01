import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';
import { ENV } from './infra/tokens.js';

/**
 * Cross-cutting HTTP setup shared by main.ts and the e2e tests,
 * so tests exercise the same headers, CORS and logging as production.
 */
export function configureApp(app: INestApplication): Env {
  const env = app.get<Env>(ENV);
  app.useLogger(app.get(Logger));
  // Review follow-up to CHAT-021: without this, Express's `req.ip` -- what every IP-tracked rate
  // limit (login attempts, and the `UserThrottlerGuard` fallback for an unauthenticated request)
  // keys on -- is always Render's own proxy address, since Express ignores `X-Forwarded-For` by
  // default. That collapsed every distinct client behind the proxy into one shared rate-limit
  // bucket. `TRUST_PROXY_HOPS` (1 in production, matching Render's single hop) tells Express how
  // many proxies to trust that header through before landing on the real client address.
  // `INestApplication` doesn't expose `set()` itself (that's an Express-specific escape hatch,
  // not part of Nest's platform-agnostic surface), so this reaches through to the underlying
  // Express instance the same way Nest's own docs do for anything Express-only.
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', env.TRUST_PROXY_HOPS);
  // CHAT-022: security headers, explicit rather than relying on helmet's defaults staying the
  // same across a future major bump. The only directive that matters for the AC ("CSP blocks
  // inline script injection") is `scriptSrc`: no 'unsafe-inline' and no 'unsafe-eval', so an
  // injected `<script>` or `onclick="..."` never executes. This API serves only JSON (no HTML
  // templates of its own), so the rest of the policy is deliberately locked down to 'none'/'self'
  // rather than tuned for a page that would ever render here.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      // This API is never framed and sets no cookies readable cross-site; COEP/CORP defaults are
      // for browser-rendered pages loading cross-origin subresources, which doesn't apply here and
      // has in the past broken avatar `<img>` loads from the S3/R2 origin in other stacks -- so
      // those two are left at helmet's permissive opt-out rather than their strict defaults.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // Reads the httpOnly refresh-token cookie (see auth/refresh-cookie.ts); it is never readable
  // from client JS, only parsed here on the way in.
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });
  app.enableShutdownHooks();
  // CHAT-013: plain `ws` gateway for the realtime endpoint, sharing this same HTTP server
  // (the default port-0 mode attaches to it via the 'upgrade' event) rather than opening one
  // of its own.
  app.useWebSocketAdapter(new WsAdapter(app));
  return env;
}

import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
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

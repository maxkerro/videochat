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
  app.use(helmet());
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

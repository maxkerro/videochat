import type { INestApplication } from '@nestjs/common';
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
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });
  app.enableShutdownHooks();
  return env;
}

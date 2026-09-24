import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { ENV } from '../infra/tokens.js';

const REQUEST_ID_HEADER = 'x-request-id';
const QUIET_PATHS = new Set(['/health', '/ready', '/metrics']);

/** CHAT-013's realtime gateway authenticates over `?token=` (the WS upgrade request can't carry
 *  an Authorization header). This keeps a live access token out of *this app's own* pino request
 *  logs for any endpoint that ends up with a `token` query param.
 *
 *  It does NOT solve the `/realtime` case specifically: the `ws` adapter (`@nestjs/platform-ws`)
 *  attaches straight to the HTTP server's `upgrade` event, so a WS upgrade request never runs
 *  through Nest's Express pipeline or this pino-http serializer at all -- there's nothing here to
 *  redact for it. It also can't reach logs written upstream of this process (e.g. Render's own
 *  proxy/access logs), which see the raw request line before it gets here. Actually closing the
 *  `/realtime?token=` exposure needs a different scheme (a short-lived single-use ticket, or the
 *  token via `Sec-WebSocket-Protocol`) -- tracked separately, not done here. */
export function redactUrl(url: string): string {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;
  const path = url.slice(0, queryIndex);
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  if (params.has('token')) params.set('token', '[redacted]');
  return `${path}?${params.toString()}`;
}

/** pino-pretty is a dev dependency; fall back to JSON if it isn't installed (e.g. a prod image). */
export function hasPrettyPrinter(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Structured JSON logs (pretty in development). Every line from a request carries `reqId`,
 * taken from the incoming X-Request-Id header or generated, and echoed back to the client.
 * When tracing is on, lines also carry trace_id/span_id so logs and traces link up.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          transport:
            env.NODE_ENV === 'development' && hasPrettyPrinter()
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const incoming = req.headers[REQUEST_ID_HEADER];
            const id =
              typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
                ? incoming
                : randomUUID();
            res.setHeader(REQUEST_ID_HEADER, id);
            return id;
          },
          // Put the request id at the top level of every log line written during the request.
          customProps: (req: IncomingMessage & { id?: unknown }) => ({ reqId: req.id }),
          serializers: {
            req: (req: { method: string; url: string }) => ({
              method: req.method,
              url: redactUrl(req.url),
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(req.url ?? '') },
          mixin: () => {
            const ctx = trace.getActiveSpan()?.spanContext();
            return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}

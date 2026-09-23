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
            req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
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

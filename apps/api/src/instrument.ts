/**
 * Observability bootstrap (CHAT-005). Must run before any other application code:
 * production starts the API with `node --import ./dist/instrument.js dist/main.js` so
 * OpenTelemetry can hook ESM modules (http, express, pg, ioredis) as they load.
 * In `pnpm dev` it is imported first from main.ts instead (errors are captured; auto-tracing
 * of ESM modules is best-effort there).
 *
 * Both integrations are opt-in: nothing is sent unless SENTRY_DSN / OTEL_EXPORTER_OTLP_ENDPOINT
 * are set.
 */
import * as Sentry from '@sentry/nestjs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { loadEnv } from './config/env.js';

const FLAG = Symbol.for('videochat.instrumented');
const globalState = globalThis as Record<symbol, unknown>;

if (!globalState[FLAG]) {
  globalState[FLAG] = true;
  const env = loadEnv();

  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      release: env.APP_VERSION,
      // Tracing goes through our own OpenTelemetry SDK below; Sentry only reports errors.
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
      // Request bodies carry passwords and (for the mobile app) refresh tokens: never send them,
      // nor cookies or the Authorization header, with an error report.
      // HTTP breadcrumbs record request URLs, which can carry `?token=`.
      beforeBreadcrumb(breadcrumb) {
        const url = breadcrumb.data?.['url'];
        if (typeof url === 'string' && breadcrumb.data) breadcrumb.data['url'] = url.split('?')[0];
        return breadcrumb;
      },
      beforeSend(event) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.query_string; // e.g. the realtime socket's `?token=`
          if (event.request.url) event.request.url = event.request.url.split('?')[0]!;
          // Node lowercases incoming header names, so these keys match.
          if (event.request.headers) {
            delete event.request.headers['authorization'];
            delete event.request.headers['cookie'];
          }
        }
        return event;
      },
    });
  }

  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: env.APP_VERSION,
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Noisy and not useful for a chat API.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
        }),
      ],
    });
    sdk.start();
    const shutdown = () => void sdk.shutdown().catch(() => undefined);
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
}

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { healthResponseSchema } from '@videochat/shared';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('HTTP app (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    await app.init();
  });
  afterAll(() => app.close());

  it('GET /health reports dependencies and matches the shared contract', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.checks).toEqual({ database: 'up', redis: 'up' });
    expect(body.status).toBe('ok');
  });

  it('GET /ready is 200 when dependencies are up', async () => {
    await request(app.getHttpServer()).get('/ready').expect(200);
  });

  it('echoes a valid incoming X-Request-Id and generates one otherwise', async () => {
    const echoed = await request(app.getHttpServer()).get('/health').set('x-request-id', 'abc-123');
    expect(echoed.headers['x-request-id']).toBe('abc-123');
    const generated = await request(app.getHttpServer()).get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers and restricts CORS to configured origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');

    const denied = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  /** CHAT-022 AC: "CSP blocks inline script injection". The literal test is on `script-src`: no
   *  `'unsafe-inline'` (and no `'unsafe-eval'`) means a `<script>` tag or inline event handler
   *  smuggled into a response a browser somehow rendered as HTML would never execute -- the
   *  browser refuses it before running a single instruction, regardless of how it got there. */
  it('sends a Content-Security-Policy header whose script-src excludes unsafe-inline', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    if (!csp) throw new Error('unreachable: asserted above');

    const scriptSrc = csp
      .split(';')
      .map((d: string) => d.trim())
      .find((d: string) => d.startsWith('script-src '));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'self'");

    // object-src 'none' closes the classic Flash/plugin injection vector CSP also covers.
    expect(csp).toContain("object-src 'none'");
  });

  it('exposes Prometheus metrics with route labels', async () => {
    await request(app.getHttpServer()).get('/does-not-exist').expect(404);
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).toMatch(/route="unmatched",status="404"/);
  });
});

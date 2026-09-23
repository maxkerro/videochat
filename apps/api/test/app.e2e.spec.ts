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

  it('exposes Prometheus metrics with route labels', async () => {
    await request(app.getHttpServer()).get('/does-not-exist').expect(404);
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).toMatch(/route="unmatched",status="404"/);
  });
});

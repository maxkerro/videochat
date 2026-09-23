import type { HealthResponse } from '@videochat/shared';
import { HealthController } from './health.controller.js';
import type { HealthService } from './health.service.js';

function makeController(response: HealthResponse) {
  const health = { check: vi.fn().mockResolvedValue(response) } as unknown as HealthService;
  return new HealthController(health);
}

function fakeResponse() {
  return { status: vi.fn() } as unknown as import('express').Response;
}

const ok: HealthResponse = {
  status: 'ok',
  version: 'test',
  uptimeSeconds: 1,
  checks: { database: 'up', redis: 'up' },
};
const degraded: HealthResponse = {
  ...ok,
  status: 'degraded',
  checks: { ...ok.checks, redis: 'down' },
};

describe('HealthController', () => {
  it('GET /health always answers 200 (liveness), whatever the dependency status', async () => {
    // @HttpCode(200) is declarative on the route; the handler itself has no status branch to test,
    // so this just pins the contract: it returns the service's report unchanged.
    const result = await makeController(degraded).getHealth();
    expect(result).toBe(degraded);
  });

  it('GET /ready responds 200 when every dependency is up', async () => {
    const res = fakeResponse();
    const result = await makeController(ok).getReady(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(result).toBe(ok);
  });

  it('GET /ready responds 503 when a dependency is down', async () => {
    const res = fakeResponse();
    const result = await makeController(degraded).getReady(res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(result).toBe(degraded);
  });
});

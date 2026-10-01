import type { INestApplication } from '@nestjs/common';
import { iceServersResponseSchema } from '@videochat/shared';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('calls (M3)', () => {
  let app: INestApplication;
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;

  beforeAll(async () => {
    ({ app, server, signUp } = await startE2eApp('calls'));
  });
  afterAll(() => app.close());

  describe('GET /calls/ice-servers (CHAT-040)', () => {
    it('401s without an access token', async () => {
      await request(server()).get('/calls/ice-servers').expect(401);
    });

    it('returns a valid RTCConfiguration.iceServers list for a signed-in user', async () => {
      const user = await signUp();
      const res = await request(server())
        .get('/calls/ice-servers')
        .set(bearer(user.token))
        .expect(200);
      const body = iceServersResponseSchema.parse(res.body);
      expect(body.ttlSeconds).toBeGreaterThan(0);
      // Default config (no TURN provider): public STUN only, and no credentials leak out.
      expect(body.iceServers.length).toBeGreaterThan(0);
      for (const server of body.iceServers) expect(server.credential).toBeUndefined();
    });
  });
});

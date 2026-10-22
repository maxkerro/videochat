import type { INestApplication } from '@nestjs/common';
import { LIMITS } from '@videochat/shared';
import pg from 'pg';
import request from 'supertest';
import { MailService } from '../src/mail/mail.service.js';
import { bearer, startE2eApp, type E2eUser, type FakeMailService } from './e2e-app.js';
import { hasInfra } from './helpers.js';

/**
 * CHAT-081: failed sign-ins only cost a short, growing delay, and the owner can always get in
 * with an emailed link or code -- so someone who knows a username can't lock its owner out.
 */
describe.skipIf(!hasInfra)('sign-in delay and emailed sign-in (CHAT-081)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  let mail: FakeMailService;
  let db: pg.Client;

  beforeAll(async () => {
    const app = await startE2eApp('ll');
    ({ server, signUp, close: closeAll } = app);
    mail = app.moduleRef.get(MailService) as unknown as FakeMailService;
    db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => {
    await db.end();
    await closeAll();
  });

  const password = 'correct-horse-battery-staple';

  async function account() {
    const user = await signUp();
    const me = await request(server()).get('/me').set(bearer(user.token)).expect(200);
    return { ...user, username: me.body.username as string, email: me.body.email as string };
  }

  const login = (identifier: string, pw: string) =>
    request(server()).post('/auth/login').send({ identifier, password: pw });

  async function failUntilDelayed(username: string) {
    for (let i = 0; i < LIMITS.loginAttemptsBeforeLockout; i++) {
      await login(username, 'wrong-password').expect(401);
    }
  }

  async function emailLink(identifier: string) {
    const before = mail.loginLinks.length;
    const res = await request(server()).post('/auth/login-link').send({ identifier }).expect(202);
    expect(res.body.message).toMatch(/If that account exists/);
    return mail.loginLinks.length > before ? mail.loginLinks.at(-1)! : null;
  }

  it('delays (not locks) after failures, and the emailed code still gets the owner in', async () => {
    const owner = await account();
    await failUntilDelayed(owner.username);

    // Even the right password waits -- a short, stated delay, with the way around it.
    const delayed = await login(owner.username, password).expect(403);
    expect(delayed.body).toMatchObject({ code: 'login_throttled' });
    expect(delayed.body.message).toMatch(
      /Try again in \d+ seconds, or sign in with an emailed code/,
    );
    expect(delayed.body.retryAfterSec).toBeLessThanOrEqual(LIMITS.loginDelayBaseSeconds);

    const sent = await emailLink(owner.username);
    expect(sent).toMatchObject({ to: owner.email });
    expect(sent!.code).toMatch(/^\d{6}$/);
    const res = await request(server())
      .post('/auth/login-link/verify')
      .send({ identifier: owner.email, code: sent!.code })
      .expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    // Signing in this way clears the delay, and the same email can't be used twice.
    await login(owner.username, password).expect(200);
    await request(server())
      .post('/auth/login-link/verify')
      .send({ token: sent!.token })
      .expect(400);
  });

  it('signs in with the link, once', async () => {
    const owner = await account();
    const sent = await emailLink(owner.email);
    await request(server())
      .post('/auth/login-link/verify')
      .send({ token: sent!.token })
      .expect(200);
    await request(server())
      .post('/auth/login-link/verify')
      .send({ token: sent!.token })
      .expect(400);
    await request(server())
      .post('/auth/login-link/verify')
      .send({ identifier: owner.username, code: sent!.code })
      .expect(400);
  });

  it('voids the codes after too many wrong guesses, but the link keeps working', async () => {
    const owner = await account();
    const sent = await emailLink(owner.username);
    const wrong = sent!.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < LIMITS.loginCodeMaxFailures; i++) {
      await request(server())
        .post('/auth/login-link/verify')
        .send({ identifier: owner.username, code: wrong })
        .expect(400);
    }
    await request(server())
      .post('/auth/login-link/verify')
      .send({ identifier: owner.username, code: sent!.code })
      .expect(400);
    await request(server())
      .post('/auth/login-link/verify')
      .send({ token: sent!.token })
      .expect(200);
  });

  it('answers the same for unknown accounts, and caps the emails per window', async () => {
    expect(await emailLink('nobody_here')).toBeNull();
    const owner = await account();
    for (let i = 0; i < LIMITS.loginLinksPerWindow; i++)
      expect(await emailLink(owner.username)).not.toBeNull();
    expect(await emailLink(owner.username)).toBeNull();
  });

  it('keeps suspended accounts out this way too', async () => {
    const owner = await account();
    await db.query(`UPDATE users SET banned_at = now() WHERE id = $1`, [owner.id]);
    const sent = await emailLink(owner.username);
    const res = await request(server())
      .post('/auth/login-link/verify')
      .send({ token: sent!.token })
      .expect(403);
    expect(res.body.message).toMatch(/banned/);
  });

  it('caps the delay at a few minutes, however many attempts a stranger makes', async () => {
    const owner = await account();
    // Ten more failures than the threshold, as if spread over time (no waiting in a test).
    for (let i = 0; i < LIMITS.loginAttemptsBeforeLockout + 10; i++) {
      await db.query(`UPDATE users SET locked_until = NULL WHERE id = $1`, [owner.id]);
      await login(owner.username, 'wrong-password').expect(401);
    }
    const { rows } = await db.query<{ wait: number }>(
      `SELECT extract(epoch FROM locked_until - now())::int AS wait FROM users WHERE id = $1`,
      [owner.id],
    );
    expect(rows[0]!.wait).toBeLessThanOrEqual(LIMITS.loginDelayMaxSeconds);
    expect(rows[0]!.wait).toBeGreaterThan(LIMITS.loginDelayMaxSeconds - 10);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authSessionSchema } from '@videochat/shared';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { createPool } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { MailService } from '../src/mail/mail.service.js';
import { hasInfra } from './helpers.js';

/** Captures the plaintext tokens AuthService hands to MailService, since only their hash is
 *  ever persisted -- this is the one place in the whole system the plaintext exists outside
 *  the response to the original request. */
class FakeMailService {
  verifyTokens: string[] = [];
  resetTokens: string[] = [];
  sendVerificationEmail(_to: string, token: string) {
    this.verifyTokens.push(token);
    return Promise.resolve();
  }
  sendPasswordResetEmail(_to: string, token: string) {
    this.resetTokens.push(token);
    return Promise.resolve();
  }
}

describe.skipIf(!hasInfra)('auth HTTP flow (CHAT-010)', () => {
  let app: INestApplication;
  let mail: FakeMailService;

  beforeAll(async () => {
    // This suite boots the real AppModule (not freshDatabase()), so it must migrate the
    // schema itself -- it can't assume another test file has already done so.
    const migrationPool = createPool(process.env.TEST_DATABASE_URL!, 1);
    await resetDatabase(migrationPool);
    await runMigrations(migrationPool);
    await migrationPool.end();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useClass(FakeMailService)
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app);
    // Listen once for the whole file instead of letting supertest do its own listen(0) +
    // close() on this same server for every single request. That per-request churn (hundreds
    // of cycles in the bigger suites) occasionally left the socket wedged on macOS, after which
    // every later request in the file failed with ETIMEDOUT. With the server already listening,
    // supertest just reuses its address. Bound to 127.0.0.1 because that's exactly the host
    // supertest connects to. messages/realtime e2e already listen once for their own reasons.
    await app.listen(0, '127.0.0.1');
    mail = moduleRef.get(MailService) as unknown as FakeMailService;
  });
  afterAll(() => app.close());

  const server = () => app.getHttpServer();

  /** supertest types `set-cookie` as possibly absent; every login/refresh in these tests sets one. */
  function requireSetCookie(res: request.Response): string[] {
    const raw = res.headers['set-cookie'] as string[] | string | undefined;
    if (!raw) throw new Error('Expected a Set-Cookie header');
    return Array.isArray(raw) ? raw : [raw];
  }
  let userCounter = 0;
  function freshUser() {
    userCounter += 1;
    return {
      email: `e2e-user-${userCounter}@test.dev`,
      username: `e2euser${userCounter}`,
      displayName: `E2E User ${userCounter}`,
      password: 'correct-horse-battery-staple',
    };
  }

  async function signUpAndVerify() {
    const user = freshUser();
    await request(server()).post('/auth/signup').send(user).expect(201);
    const token = mail.verifyTokens.at(-1)!;
    await request(server()).post('/auth/verify-email').send({ token }).expect(200);
    return user;
  }

  it('rejects login before the email is verified', async () => {
    const user = freshUser();
    await request(server()).post('/auth/signup').send(user).expect(201);
    await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(403);
  });

  it('signs up, verifies, logs in, and reaches an authenticated endpoint', async () => {
    const user = await signUpAndVerify();
    const res = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const session = authSessionSchema.parse(res.body);
    expect(session.user.email).toBe(user.email);
    expect(session.user.emailVerified).toBe(true);

    const refreshCookie = requireSetCookie(res).find((c) => c.startsWith('refresh_token='));
    expect(refreshCookie).toMatch(/HttpOnly/);

    const me = await request(server())
      .get('/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect(me.body.username).toBe(user.username);
  });

  it('rejects a wrong password without revealing whether the email exists', async () => {
    const user = await signUpAndVerify();
    const wrongPassword = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: 'nope-nope-nope' })
      .expect(401);
    const unknownEmail = await request(server())
      .post('/auth/login')
      .send({ email: 'no-such-user@test.dev', password: 'nope-nope-nope' })
      .expect(401);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it('locks the account after repeated failed logins', async () => {
    const user = await signUpAndVerify();
    for (let i = 0; i < 4; i++) {
      await request(server())
        .post('/auth/login')
        .send({ email: user.email, password: 'wrong' })
        .expect(401);
    }
    // 5th failure trips the lockout.
    await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: 'wrong' })
      .expect(401);
    // Even the correct password is refused while locked.
    await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(403);
  });

  describe('logging in with a username (CHAT-080)', () => {
    it('logs in with username + password, ignoring case and surrounding spaces', async () => {
      const user = await signUpAndVerify();
      const res = await request(server())
        .post('/auth/login')
        .send({ identifier: `  ${user.username.toUpperCase()} `, password: user.password })
        .expect(200);
      expect(authSessionSchema.parse(res.body).user.username).toBe(user.username);
    });

    it('still logs in with email as the identifier, and with the legacy {email} body', async () => {
      const user = await signUpAndVerify();
      await request(server())
        .post('/auth/login')
        .send({ identifier: user.email, password: user.password })
        .expect(200);
      await request(server())
        .post('/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);
    });

    it('gives an unknown username, a wrong password and an unknown email the same answer', async () => {
      const user = await signUpAndVerify();
      const answers = await Promise.all(
        [
          { identifier: 'no_such_user_here', password: 'nope-nope-nope' },
          { identifier: user.username, password: 'nope-nope-nope' },
          { identifier: 'no-such-user@test.dev', password: 'nope-nope-nope' },
          // Looks like an email, so it's looked up as one -- never as a username.
          { identifier: `${user.username}@`, password: user.password },
        ].map((body) => request(server()).post('/auth/login').send(body).expect(401)),
      );
      expect(new Set(answers.map((a) => a.body.message)).size).toBe(1);
      expect(answers[0]!.body.message).toBe('Incorrect email/username or password');
    });

    it('counts failures across username and email toward the same lockout', async () => {
      const user = await signUpAndVerify();
      for (let i = 0; i < 5; i++) {
        await request(server())
          .post('/auth/login')
          .send({ identifier: i % 2 ? user.email : user.username, password: 'wrong' })
          .expect(401);
      }
      await request(server())
        .post('/auth/login')
        .send({ identifier: user.username, password: user.password })
        .expect(403);
    });

    it('rejects a body with neither identifier nor email', async () => {
      await request(server()).post('/auth/login').send({ password: 'whatever' }).expect(400);
    });
  });

  it('GET /me rejects a missing or invalid access token', async () => {
    await request(server()).get('/me').expect(401);
    await request(server()).get('/me').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('rotates the refresh token and rejects reuse of a rotated-away token', async () => {
    const user = await signUpAndVerify();
    const login = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookie = requireSetCookie(login);

    const refreshed = await request(server())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(200);
    authSessionSchema.parse(refreshed.body);

    // The original refresh token was rotated away by the call above; presenting it again
    // must be rejected (reuse detection), not silently accepted.
    await request(server()).post('/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('logs out and invalidates the refresh token', async () => {
    const user = await signUpAndVerify();
    const login = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookie = requireSetCookie(login);

    await request(server()).post('/auth/logout').set('Cookie', cookie).expect(200);
    await request(server()).post('/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('resets a forgotten password and revokes existing sessions', async () => {
    const user = await signUpAndVerify();
    const login = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    const oldCookie = requireSetCookie(login);

    await request(server())
      .post('/auth/request-password-reset')
      .send({ email: user.email })
      .expect(200);
    const resetToken = mail.resetTokens.at(-1)!;
    const newPassword = 'a-brand-new-password';
    await request(server())
      .post('/auth/reset-password')
      .send({ token: resetToken, password: newPassword })
      .expect(200);

    // The session from before the reset no longer works...
    await request(server()).post('/auth/refresh').set('Cookie', oldCookie).expect(401);
    // ...and the old password no longer works, but the new one does.
    await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(401);
    await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: newPassword })
      .expect(200);
  });

  it('rejects a duplicate sign-up email or username', async () => {
    const user = await signUpAndVerify();
    await request(server()).post('/auth/signup').send(user).expect(409);
    await request(server())
      .post('/auth/signup')
      .send({ ...freshUser(), username: user.username })
      .expect(409);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authSessionSchema, type AuthSession } from '@videochat/shared';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { createPool } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { MailService } from '../src/mail/mail.service.js';
import { hasInfra } from './helpers.js';

class FakeMailService {
  verifyTokens: string[] = [];
  sendVerificationEmail(_to: string, token: string) {
    this.verifyTokens.push(token);
    return Promise.resolve();
  }
  sendPasswordResetEmail() {
    return Promise.resolve();
  }
}

describe.skipIf(!hasInfra)('conversations HTTP flow (CHAT-012)', () => {
  let app: INestApplication;
  let mail: FakeMailService;

  beforeAll(async () => {
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
    await app.init();
    mail = moduleRef.get(MailService) as unknown as FakeMailService;
  });
  afterAll(() => app.close());

  const server = () => app.getHttpServer();

  let userCounter = 0;
  async function signUpAndLogIn(): Promise<{
    email: string;
    username: string;
    session: AuthSession;
  }> {
    userCounter += 1;
    const user = {
      email: `conv-user-${userCounter}@test.dev`,
      username: `convuser${userCounter}`,
      displayName: `Conv User ${userCounter}`,
      password: 'correct-horse-battery-staple',
    };
    await request(server()).post('/auth/signup').send(user).expect(201);
    const token = mail.verifyTokens.at(-1)!;
    await request(server()).post('/auth/verify-email').send({ token }).expect(200);
    const res = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return {
      email: user.email,
      username: user.username,
      session: authSessionSchema.parse(res.body),
    };
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  describe('GET /users/search', () => {
    it('finds another user by username prefix, excluding the caller', async () => {
      const a = await signUpAndLogIn();
      const b = await signUpAndLogIn();

      const res = await request(server())
        .get('/users/search')
        .query({ q: b.username.slice(0, -1) })
        .set(auth(a.session.accessToken))
        .expect(200);

      expect(res.body.users.map((u: { username: string }) => u.username)).toContain(b.username);
      expect(res.body.users.map((u: { username: string }) => u.username)).not.toContain(a.username);
    });

    it('finds another user by exact email, but not by partial email', async () => {
      const a = await signUpAndLogIn();
      const b = await signUpAndLogIn();

      const exact = await request(server())
        .get('/users/search')
        .query({ q: b.email })
        .set(auth(a.session.accessToken))
        .expect(200);
      expect(exact.body.users.map((u: { username: string }) => u.username)).toEqual([b.username]);

      const partial = await request(server())
        .get('/users/search')
        .query({ q: b.email.slice(0, -4) })
        .set(auth(a.session.accessToken))
        .expect(200);
      expect(partial.body.users).toEqual([]);
    });

    it('requires authentication', async () => {
      await request(server()).get('/users/search').query({ q: 'x' }).expect(401);
    });
  });

  describe('POST /conversations/direct and GET /conversations', () => {
    it('starts a direct conversation and lists it for both members', async () => {
      const a = await signUpAndLogIn();
      const b = await signUpAndLogIn();

      const meRes = await request(server()).get('/me').set(auth(b.session.accessToken)).expect(200);

      const started = await request(server())
        .post('/conversations/direct')
        .set(auth(a.session.accessToken))
        .send({ userId: meRes.body.id })
        .expect(201);
      expect(started.body.type).toBe('direct');
      expect(started.body.peer.username).toBe(b.username);

      const again = await request(server())
        .post('/conversations/direct')
        .set(auth(a.session.accessToken))
        .send({ userId: meRes.body.id })
        .expect(201);
      expect(again.body.id).toBe(started.body.id);

      const listForA = await request(server())
        .get('/conversations')
        .set(auth(a.session.accessToken))
        .expect(200);
      expect(listForA.body.map((c: { id: string }) => c.id)).toContain(started.body.id);

      const listForB = await request(server())
        .get('/conversations')
        .set(auth(b.session.accessToken))
        .expect(200);
      expect(listForB.body[0].peer.username).toBe(a.username);
    });

    it('gets a single conversation by id for a member, and 404s for a non-member', async () => {
      const a = await signUpAndLogIn();
      const b = await signUpAndLogIn();
      const outsider = await signUpAndLogIn();
      const bMe = await request(server()).get('/me').set(auth(b.session.accessToken)).expect(200);
      const started = await request(server())
        .post('/conversations/direct')
        .set(auth(a.session.accessToken))
        .send({ userId: bMe.body.id })
        .expect(201);

      const got = await request(server())
        .get(`/conversations/${started.body.id}`)
        .set(auth(a.session.accessToken))
        .expect(200);
      expect(got.body).toEqual(started.body);

      await request(server())
        .get(`/conversations/${started.body.id}`)
        .set(auth(outsider.session.accessToken))
        .expect(404);
    });

    it('returns 404 (not 500) for a conversation id that is not a UUID at all', async () => {
      const a = await signUpAndLogIn();
      await request(server())
        .get('/conversations/not-a-uuid')
        .set(auth(a.session.accessToken))
        .expect(404);
    });

    it('rejects starting a conversation with a user that does not exist', async () => {
      const a = await signUpAndLogIn();
      await request(server())
        .post('/conversations/direct')
        .set(auth(a.session.accessToken))
        .send({ userId: '00000000-0000-0000-0000-000000000000' })
        .expect(404);
    });

    it('rejects starting a conversation with yourself', async () => {
      const a = await signUpAndLogIn();
      const meRes = await request(server()).get('/me').set(auth(a.session.accessToken)).expect(200);
      await request(server())
        .post('/conversations/direct')
        .set(auth(a.session.accessToken))
        .send({ userId: meRes.body.id })
        .expect(400);
    });

    it('requires authentication', async () => {
      await request(server()).get('/conversations').expect(401);
      await request(server()).post('/conversations/direct').send({ userId: 'x' }).expect(401);
    });
  });
});

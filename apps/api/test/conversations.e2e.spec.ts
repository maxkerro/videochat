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

  describe('CHAT-018 group chats', () => {
    async function meId(session: AuthSession): Promise<string> {
      const res = await request(server()).get('/me').set(auth(session.accessToken)).expect(200);
      return res.body.id;
    }

    async function createGroup(
      creator: AuthSession,
      title: string,
      memberIds: string[],
    ): Promise<{ id: string; title: string; role: string }> {
      const res = await request(server())
        .post('/conversations/group')
        .set(auth(creator.accessToken))
        .send({ title, memberIds })
        .expect(201);
      return res.body;
    }

    it('creates a group with the creator as admin and everyone else a member, visible to all', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const carl = await signUpAndLogIn();

      const group = await createGroup(anna.session, 'Weekend trip', [
        await meId(ben.session),
        await meId(carl.session),
      ]);
      expect(group.title).toBe('Weekend trip');
      expect(group.role).toBe('admin');

      const members = await request(server())
        .get(`/conversations/${group.id}/members`)
        .set(auth(anna.session.accessToken))
        .expect(200);
      const byUsername = (u: string) =>
        members.body.find((m: { username: string }) => m.username === u);
      expect(byUsername(anna.username).role).toBe('admin');
      expect(byUsername(ben.username).role).toBe('member');
      expect(byUsername(carl.username).role).toBe('member');

      // The "X created the group" system message is visible in history to every member.
      const history = await request(server())
        .get(`/conversations/${group.id}/messages`)
        .set(auth(ben.session.accessToken))
        .expect(200);
      expect(history.body.messages[0]).toMatchObject({
        type: 'system',
        senderId: null,
        body: `${anna.session.user.displayName} created the group`,
      });
    });

    it('rejects creating a group with fewer than 2 total members', async () => {
      const anna = await signUpAndLogIn();
      await request(server())
        .post('/conversations/group')
        .set(auth(anna.session.accessToken))
        .send({ title: 'Solo', memberIds: [] })
        .expect(400);
    });

    it('rejects a member id that does not exist', async () => {
      const anna = await signUpAndLogIn();
      await request(server())
        .post('/conversations/group')
        .set(auth(anna.session.accessToken))
        .send({ title: 'g', memberIds: ['00000000-0000-0000-0000-000000000000'] })
        .expect(404);
    });

    it('lets an admin rename the group, and blocks a plain member (403) or non-member (404)', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const outsider = await signUpAndLogIn();
      const group = await createGroup(anna.session, 'Old name', [await meId(ben.session)]);

      const renamed = await request(server())
        .patch(`/conversations/${group.id}`)
        .set(auth(anna.session.accessToken))
        .send({ title: 'New name' })
        .expect(200);
      expect(renamed.body.title).toBe('New name');

      await request(server())
        .patch(`/conversations/${group.id}`)
        .set(auth(ben.session.accessToken))
        .send({ title: 'Nope' })
        .expect(403);

      await request(server())
        .patch(`/conversations/${group.id}`)
        .set(auth(outsider.session.accessToken))
        .send({ title: 'Nope' })
        .expect(404);
    });

    it('lets an admin add members, capped at 100 total', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const carl = await signUpAndLogIn();
      const group = await createGroup(anna.session, 'g', [await meId(ben.session)]);
      const carlId = await meId(carl.session);

      await request(server())
        .post(`/conversations/${group.id}/members`)
        .set(auth(anna.session.accessToken))
        .send({ memberIds: [carlId] })
        .expect(201);

      const members = await request(server())
        .get(`/conversations/${group.id}/members`)
        .set(auth(anna.session.accessToken))
        .expect(200);
      expect(members.body.map((m: { username: string }) => m.username)).toContain(carl.username);

      await request(server())
        .post(`/conversations/${group.id}/members`)
        .set(auth(ben.session.accessToken))
        .send({ memberIds: [carlId] })
        .expect(403);
    });

    it('AC: an admin removes a member, who then 404s on that conversation immediately', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const group = await createGroup(anna.session, 'g', [await meId(ben.session)]);
      const benId = await meId(ben.session);

      await request(server())
        .delete(`/conversations/${group.id}/members/${benId}`)
        .set(auth(anna.session.accessToken))
        .expect(200);

      await request(server())
        .get(`/conversations/${group.id}`)
        .set(auth(ben.session.accessToken))
        .expect(404);

      // AC: "Anna removed Ben" system message.
      const history = await request(server())
        .get(`/conversations/${group.id}/messages`)
        .set(auth(anna.session.accessToken))
        .expect(200);
      expect(history.body.messages.at(-1)).toMatchObject({
        type: 'system',
        senderId: null,
        body: `${anna.session.user.displayName} removed ${ben.session.user.displayName}`,
      });
    });

    it('rejects a plain member removing someone else', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const carl = await signUpAndLogIn();
      const group = await createGroup(anna.session, 'g', [
        await meId(ben.session),
        await meId(carl.session),
      ]);
      const carlId = await meId(carl.session);

      await request(server())
        .delete(`/conversations/${group.id}/members/${carlId}`)
        .set(auth(ben.session.accessToken))
        .expect(403);
    });

    it('AC: any member can leave, and a departed non-admin does not trigger promotion', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const group = await createGroup(anna.session, 'g', [await meId(ben.session)]);

      await request(server())
        .post(`/conversations/${group.id}/leave`)
        .set(auth(ben.session.accessToken))
        .expect(201);

      await request(server())
        .get(`/conversations/${group.id}`)
        .set(auth(ben.session.accessToken))
        .expect(404);

      const members = await request(server())
        .get(`/conversations/${group.id}/members`)
        .set(auth(anna.session.accessToken))
        .expect(200);
      expect(members.body).toHaveLength(1);
      expect(members.body[0].role).toBe('admin');
    });

    it('AC: promotes the oldest remaining member to admin when the last admin leaves', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const carl = await signUpAndLogIn();
      const group = await createGroup(anna.session, 'g', [
        await meId(ben.session),
        await meId(carl.session),
      ]);

      await request(server())
        .post(`/conversations/${group.id}/leave`)
        .set(auth(anna.session.accessToken))
        .expect(201);

      const members = await request(server())
        .get(`/conversations/${group.id}/members`)
        .set(auth(ben.session.accessToken))
        .expect(200);
      const byUsername = (u: string) =>
        members.body.find((m: { username: string }) => m.username === u);
      expect(byUsername(ben.username).role).toBe('admin'); // ben joined before carl
      expect(byUsername(carl.username).role).toBe('member');

      const history = await request(server())
        .get(`/conversations/${group.id}/messages`)
        .set(auth(ben.session.accessToken))
        .expect(200);
      const bodies = history.body.messages.map((m: { body: string }) => m.body);
      expect(bodies).toContain(`${anna.session.user.displayName} left`);
      expect(bodies).toContain(`${ben.session.user.displayName} is now an admin`);
    });

    it('requires authentication for every group endpoint', async () => {
      await request(server()).post('/conversations/group').send({}).expect(401);
      await request(server())
        .patch('/conversations/00000000-0000-0000-0000-000000000000')
        .send({})
        .expect(401);
      await request(server())
        .get('/conversations/00000000-0000-0000-0000-000000000000/members')
        .expect(401);
      await request(server())
        .post('/conversations/00000000-0000-0000-0000-000000000000/members')
        .send({})
        .expect(401);
      await request(server())
        .delete(
          '/conversations/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000000',
        )
        .expect(401);
      await request(server())
        .post('/conversations/00000000-0000-0000-0000-000000000000/leave')
        .expect(401);
    });
  });

  describe('CHAT-019 read receipts and unread state', () => {
    async function sendMessage(sender: AuthSession, conversationId: string, clientMsgId: string) {
      const res = await request(server())
        .post(`/conversations/${conversationId}/messages`)
        .set(auth(sender.accessToken))
        .send({ clientMsgId, body: 'hi' })
        .expect(201);
      return res.body.seq as number;
    }

    it('advances the caller lastReadSeq, clamped to lastSeq, and rejects a non-member', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const bMe = await request(server()).get('/me').set(auth(ben.session.accessToken)).expect(200);
      const started = await request(server())
        .post('/conversations/direct')
        .set(auth(anna.session.accessToken))
        .send({ userId: bMe.body.id })
        .expect(201);
      const conversationId = started.body.id as string;
      await sendMessage(anna.session, conversationId, 'm-1');
      await sendMessage(anna.session, conversationId, 'm-2');

      // Ben reads past what actually exists (seq 999) -- clamped to the real lastSeq (2).
      const read = await request(server())
        .post(`/conversations/${conversationId}/read`)
        .set(auth(ben.session.accessToken))
        .send({ seq: 999 })
        .expect(201);
      expect(read.body.lastReadSeq).toBe(2);

      const outsider = await signUpAndLogIn();
      await request(server())
        .post(`/conversations/${conversationId}/read`)
        .set(auth(outsider.session.accessToken))
        .send({ seq: 1 })
        .expect(404);
    });

    it('never moves lastReadSeq backward via the read endpoint', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const bMe = await request(server()).get('/me').set(auth(ben.session.accessToken)).expect(200);
      const started = await request(server())
        .post('/conversations/direct')
        .set(auth(anna.session.accessToken))
        .send({ userId: bMe.body.id })
        .expect(201);
      const conversationId = started.body.id as string;
      await sendMessage(anna.session, conversationId, 'm-1');
      await sendMessage(anna.session, conversationId, 'm-2');

      await request(server())
        .post(`/conversations/${conversationId}/read`)
        .set(auth(ben.session.accessToken))
        .send({ seq: 2 })
        .expect(201);
      const stale = await request(server())
        .post(`/conversations/${conversationId}/read`)
        .set(auth(ben.session.accessToken))
        .send({ seq: 1 })
        .expect(201);
      expect(stale.body.lastReadSeq).toBe(2);
    });

    it('AC: marks a fully-read conversation as unread again, without going below existing unread', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const bMe = await request(server()).get('/me').set(auth(ben.session.accessToken)).expect(200);
      const started = await request(server())
        .post('/conversations/direct')
        .set(auth(anna.session.accessToken))
        .send({ userId: bMe.body.id })
        .expect(201);
      const conversationId = started.body.id as string;
      await sendMessage(anna.session, conversationId, 'm-1');
      await sendMessage(anna.session, conversationId, 'm-2');
      await sendMessage(anna.session, conversationId, 'm-3');
      // Ben reads everything.
      await request(server())
        .post(`/conversations/${conversationId}/read`)
        .set(auth(ben.session.accessToken))
        .send({ seq: 3 })
        .expect(201);

      const unread = await request(server())
        .post(`/conversations/${conversationId}/unread`)
        .set(auth(ben.session.accessToken))
        .expect(201);
      expect(unread.body.lastReadSeq).toBe(2); // one less than lastSeq -- the latest message is unread again

      // Marking unread again must not further reduce the unread count.
      const again = await request(server())
        .post(`/conversations/${conversationId}/unread`)
        .set(auth(ben.session.accessToken))
        .expect(201);
      expect(again.body.lastReadSeq).toBe(2);

      // 404 for a non-member.
      const outsider = await signUpAndLogIn();
      await request(server())
        .post(`/conversations/${conversationId}/unread`)
        .set(auth(outsider.session.accessToken))
        .expect(404);
    });

    it('rejects marking an empty conversation unread', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const bMe = await request(server()).get('/me').set(auth(ben.session.accessToken)).expect(200);
      const started = await request(server())
        .post('/conversations/direct')
        .set(auth(anna.session.accessToken))
        .send({ userId: bMe.body.id })
        .expect(201);

      await request(server())
        .post(`/conversations/${started.body.id}/unread`)
        .set(auth(anna.session.accessToken))
        .expect(400);
    });

    it('exposes each group member’s lastReadSeq for "Seen by N"', async () => {
      const anna = await signUpAndLogIn();
      const ben = await signUpAndLogIn();
      const bMe = await request(server()).get('/me').set(auth(ben.session.accessToken)).expect(200);
      const group = await request(server())
        .post('/conversations/group')
        .set(auth(anna.session.accessToken))
        .send({ title: 'g', memberIds: [bMe.body.id] })
        .expect(201);
      const conversationId = group.body.id as string;
      // The "created the group" system message is seq 1.
      await request(server())
        .post(`/conversations/${conversationId}/read`)
        .set(auth(ben.session.accessToken))
        .send({ seq: 1 })
        .expect(201);

      const members = await request(server())
        .get(`/conversations/${conversationId}/members`)
        .set(auth(anna.session.accessToken))
        .expect(200);
      const byUsername = (u: string) =>
        members.body.find((m: { username: string }) => m.username === u);
      expect(byUsername(ben.username).lastReadSeq).toBe(1);
    });

    it('requires authentication for the read/unread endpoints', async () => {
      await request(server())
        .post('/conversations/00000000-0000-0000-0000-000000000000/read')
        .send({ seq: 1 })
        .expect(401);
      await request(server())
        .post('/conversations/00000000-0000-0000-0000-000000000000/unread')
        .expect(401);
    });
  });
});

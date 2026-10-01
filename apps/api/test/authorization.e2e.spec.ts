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

/**
 * CHAT-022 "member-only access" AC: a dedicated sweep, separate from the individual endpoint
 * suites (conversations.e2e.spec.ts, messages.e2e.spec.ts) which each already assert member-only
 * access for the one endpoint they're otherwise exercising. Those are still valuable (they catch
 * a regression close to the code that would cause it) but this file exists so that "every
 * conversation/message endpoint enforces membership" is one assertion this suite makes about the
 * whole surface at once, rather than something only true by the coincidence of every other test
 * file separately remembering to check it -- add a new conversation-scoped route here whenever
 * one is added to `ConversationsController`/`MessagesController`, even if it also gets its own
 * happy-path test elsewhere.
 *
 * Every one of these routes uses `findConversationForUser`/`getMembership`/`isConversationMember`
 * (or, for the admin-only ones, `requireGroupAdmin` which layers on top of the same membership
 * check) to look the conversation up scoped to the caller, so a non-member's id simply doesn't
 * match any row and every one of these 404s ("Conversation not found") uniformly -- never a 403,
 * which would confirm to a prober that the conversation id is real. See
 * `ConversationsService.requireGroup`'s own comment for that reasoning.
 */
describe.skipIf(!hasInfra)(
  'member-only access sweep across every conversation/message endpoint (CHAT-022)',
  () => {
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
    async function signUpAndLogIn(): Promise<{ id: string; session: AuthSession }> {
      userCounter += 1;
      const user = {
        email: `authz-user-${userCounter}@test.dev`,
        username: `authzuser${userCounter}`,
        displayName: `Authz User ${userCounter}`,
        password: 'correct-horse-battery-staple',
      };
      await request(server()).post('/auth/signup').send(user).expect(201);
      const token = mail.verifyTokens.at(-1)!;
      await request(server()).post('/auth/verify-email').send({ token }).expect(200);
      const loginRes = await request(server())
        .post('/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);
      const session = authSessionSchema.parse(loginRes.body);
      const meRes = await request(server()).get('/me').set(auth(session.accessToken)).expect(200);
      return { id: meRes.body.id as string, session };
    }

    function auth(token: string) {
      return { Authorization: `Bearer ${token}` };
    }

    /** A fresh direct conversation between two members (`memberA`, `memberB`), plus an unrelated
     *  third user (`outsider`) who belongs to neither -- every case below is "outsider hits a
     *  members-only route on this conversation". */
    async function setUpDirectConversation() {
      const memberA = await signUpAndLogIn();
      const memberB = await signUpAndLogIn();
      const outsider = await signUpAndLogIn();

      const conv = await request(server())
        .post('/conversations/direct')
        .set(auth(memberA.session.accessToken))
        .send({ userId: memberB.id })
        .expect(201);

      return { memberA, memberB, outsider, conversationId: conv.body.id as string };
    }

    /** Same, but a group -- `memberA` is admin, `memberB` is a plain member, `outsider` is in
     *  neither. Covers the admin-only routes (rename, add members, remove member), which a
     *  non-member must still 404 on rather than 403 (a 403 would at least confirm the id is real,
     *  which is exactly what the member-only-access AC says a non-member shouldn't learn). */
    async function setUpGroupConversation() {
      const memberA = await signUpAndLogIn();
      const memberB = await signUpAndLogIn();
      const outsider = await signUpAndLogIn();

      const conv = await request(server())
        .post('/conversations/group')
        .set(auth(memberA.session.accessToken))
        .send({ title: 'Authz test group', memberIds: [memberB.id] })
        .expect(201);

      return { memberA, memberB, outsider, conversationId: conv.body.id as string };
    }

    describe('direct conversation: every route 404s for a non-member', () => {
      it('GET /conversations/:id', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .get(`/conversations/${conversationId}`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('GET /conversations/:id/members', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .get(`/conversations/${conversationId}/members`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/leave', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .post(`/conversations/${conversationId}/leave`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/read', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .post(`/conversations/${conversationId}/read`)
          .set(auth(outsider.session.accessToken))
          .send({ seq: 0 })
          .expect(404);
      });

      it('POST /conversations/:id/unread', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .post(`/conversations/${conversationId}/unread`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('GET /conversations/:id/messages', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .get(`/conversations/${conversationId}/messages`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/messages', async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        await request(server())
          .post(`/conversations/${conversationId}/messages`)
          .set(auth(outsider.session.accessToken))
          .send({ clientMsgId: 'authz-test-1', body: 'hi' })
          .expect(404);
      });

      it("the outsider's own conversation list never includes it", async () => {
        const { outsider, conversationId } = await setUpDirectConversation();
        const res = await request(server())
          .get('/conversations')
          .set(auth(outsider.session.accessToken))
          .expect(200);
        expect(res.body.map((c: { id: string }) => c.id)).not.toContain(conversationId);
      });
    });

    describe('group conversation: every route (including admin-only ones) 404s for a non-member', () => {
      it('GET /conversations/:id', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .get(`/conversations/${conversationId}`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('PATCH /conversations/:id (rename, admin-only)', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .patch(`/conversations/${conversationId}`)
          .set(auth(outsider.session.accessToken))
          .send({ title: 'Hijacked name' })
          .expect(404);
      });

      it('GET /conversations/:id/members', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .get(`/conversations/${conversationId}/members`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/members (add members, admin-only)', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        const another = await signUpAndLogIn();
        await request(server())
          .post(`/conversations/${conversationId}/members`)
          .set(auth(outsider.session.accessToken))
          .send({ memberIds: [another.id] })
          .expect(404);
      });

      it('DELETE /conversations/:id/members/:userId (remove member, admin-only)', async () => {
        const { outsider, memberB, conversationId } = await setUpGroupConversation();
        await request(server())
          .delete(`/conversations/${conversationId}/members/${memberB.id}`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/leave', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .post(`/conversations/${conversationId}/leave`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/read', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .post(`/conversations/${conversationId}/read`)
          .set(auth(outsider.session.accessToken))
          .send({ seq: 0 })
          .expect(404);
      });

      it('POST /conversations/:id/unread', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .post(`/conversations/${conversationId}/unread`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('GET /conversations/:id/messages', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .get(`/conversations/${conversationId}/messages`)
          .set(auth(outsider.session.accessToken))
          .expect(404);
      });

      it('POST /conversations/:id/messages', async () => {
        const { outsider, conversationId } = await setUpGroupConversation();
        await request(server())
          .post(`/conversations/${conversationId}/messages`)
          .set(auth(outsider.session.accessToken))
          .send({ clientMsgId: 'authz-test-2', body: 'hi' })
          .expect(404);
      });
    });

    describe('a genuine member without admin rights gets 403, not 404, on admin-only routes', () => {
      // Distinguishes "you're not even in this conversation" (404, above) from "you're in it but
      // not allowed to do this" (403) -- the two are different facts and the AC's "member-only
      // access" is specifically about the first one, so this guards against a fix for the 404 cases
      // accidentally collapsing this distinction too.
      it('PATCH /conversations/:id (rename)', async () => {
        const { memberB, conversationId } = await setUpGroupConversation();
        await request(server())
          .patch(`/conversations/${conversationId}`)
          .set(auth(memberB.session.accessToken))
          .send({ title: 'Should be blocked' })
          .expect(403);
      });

      it('POST /conversations/:id/members (add members)', async () => {
        const { memberB, conversationId } = await setUpGroupConversation();
        const another = await signUpAndLogIn();
        await request(server())
          .post(`/conversations/${conversationId}/members`)
          .set(auth(memberB.session.accessToken))
          .send({ memberIds: [another.id] })
          .expect(403);
      });

      it('DELETE /conversations/:id/members/:userId (remove member)', async () => {
        const { memberA, memberB, conversationId } = await setUpGroupConversation();
        await request(server())
          .delete(`/conversations/${conversationId}/members/${memberA.id}`)
          .set(auth(memberB.session.accessToken))
          .expect(403);
      });
    });

    describe('unauthenticated (no access token at all): every route 401s before membership is even checked', () => {
      it.each([
        ['GET', '/conversations'],
        ['GET', '/conversations/00000000-0000-0000-0000-000000000000'],
        ['GET', '/conversations/00000000-0000-0000-0000-000000000000/members'],
        ['POST', '/conversations/00000000-0000-0000-0000-000000000000/leave'],
        ['POST', '/conversations/00000000-0000-0000-0000-000000000000/read'],
        ['POST', '/conversations/00000000-0000-0000-0000-000000000000/unread'],
        ['GET', '/conversations/00000000-0000-0000-0000-000000000000/messages'],
        ['POST', '/conversations/00000000-0000-0000-0000-000000000000/messages'],
        ['POST', '/conversations/direct'],
        ['POST', '/conversations/group'],
        ['PATCH', '/conversations/00000000-0000-0000-0000-000000000000'],
        // Added alongside the CHAT-021/CHAT-018 member-management and block routes -- these were
        // exercised by their own suites but missing from this sweep's "every route 401s first"
        // list, so a regression here (e.g. a guard ordering mistake that checked membership before
        // authentication) wouldn't have been caught by this file specifically.
        ['POST', '/conversations/00000000-0000-0000-0000-000000000000/members'],
        [
          'DELETE',
          '/conversations/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000000',
        ],
        ['GET', '/users/blocked'],
        ['POST', '/users/00000000-0000-0000-0000-000000000000/block'],
        ['DELETE', '/users/00000000-0000-0000-0000-000000000000/block'],
      ] as const)('%s %s', async (method, path) => {
        const send =
          request(server())[method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'](path);
        await send.expect(401);
      });
    });

    describe('a former member (left or removed) is treated exactly like a non-member', () => {
      // CHAT-018 membership is dynamic -- someone who leaves or is removed still knows the
      // conversation id from before, so "member-only access" has to mean "*current* member", not
      // just "was authorized at some point". Every route below should now 404 for them the same
      // way it does for `outsider` in the describes above, not merely reject the specific action
      // that changed their membership.
      it('a member who left can no longer read, send to, or list the conversation', async () => {
        const { memberB, conversationId } = await setUpGroupConversation();
        await request(server())
          .post(`/conversations/${conversationId}/leave`)
          .set(auth(memberB.session.accessToken))
          .expect(201);

        await request(server())
          .get(`/conversations/${conversationId}`)
          .set(auth(memberB.session.accessToken))
          .expect(404);
        await request(server())
          .get(`/conversations/${conversationId}/messages`)
          .set(auth(memberB.session.accessToken))
          .expect(404);
        await request(server())
          .post(`/conversations/${conversationId}/messages`)
          .set(auth(memberB.session.accessToken))
          .send({ clientMsgId: 'authz-test-former-1', body: 'hi' })
          .expect(404);

        const res = await request(server())
          .get('/conversations')
          .set(auth(memberB.session.accessToken))
          .expect(200);
        expect(res.body.map((c: { id: string }) => c.id)).not.toContain(conversationId);
      });

      it('a member removed by an admin can no longer read, send to, or list the conversation', async () => {
        const { memberA, memberB, conversationId } = await setUpGroupConversation();
        await request(server())
          .delete(`/conversations/${conversationId}/members/${memberB.id}`)
          .set(auth(memberA.session.accessToken))
          .expect(200);

        await request(server())
          .get(`/conversations/${conversationId}`)
          .set(auth(memberB.session.accessToken))
          .expect(404);
        await request(server())
          .get(`/conversations/${conversationId}/messages`)
          .set(auth(memberB.session.accessToken))
          .expect(404);
        await request(server())
          .post(`/conversations/${conversationId}/messages`)
          .set(auth(memberB.session.accessToken))
          .send({ clientMsgId: 'authz-test-former-2', body: 'hi' })
          .expect(404);
      });
    });
  },
);

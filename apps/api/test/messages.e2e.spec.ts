import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authSessionSchema, type AuthSession } from '@videochat/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
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

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a message')), timeoutMs);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe.skipIf(!hasInfra)('messages HTTP flow (CHAT-014)', () => {
  let app: INestApplication;
  let mail: FakeMailService;
  let wsUrl: (path: string) => string;
  let userCounter = 0;
  const openSockets: WebSocket[] = [];

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
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    wsUrl = (path: string) => `ws://127.0.0.1:${port}${path}`;
    mail = moduleRef.get(MailService) as unknown as FakeMailService;
  });
  afterAll(() => app.close());
  afterEach(() => {
    for (const ws of openSockets.splice(0)) ws.close();
  });

  const server = () => app.getHttpServer();

  async function signUpAndLogIn(): Promise<AuthSession> {
    userCounter += 1;
    const user = {
      email: `msg-user-${userCounter}@test.dev`,
      username: `msguser${userCounter}`,
      displayName: `Msg User ${userCounter}`,
      password: 'correct-horse-battery-staple',
    };
    await request(server()).post('/auth/signup').send(user).expect(201);
    const token = mail.verifyTokens.at(-1)!;
    await request(server()).post('/auth/verify-email').send({ token }).expect(200);
    const res = await request(server())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return authSessionSchema.parse(res.body);
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function startDirectConversation(a: AuthSession, b: AuthSession): Promise<string> {
    const started = await request(server())
      .post('/conversations/direct')
      .set(auth(a.accessToken))
      .send({ userId: b.user.id })
      .expect(201);
    return started.body.id as string;
  }

  it('sends a message, delivers it live to the other member, and lists it in history', async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const conversationId = await startDirectConversation(a, b);

    const socketB = new WebSocket(wsUrl(`/realtime?token=${b.accessToken}`));
    openSockets.push(socketB);
    await waitForOpen(socketB);

    const delivered = waitForMessage(socketB);
    const sent = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'c-1', body: 'hello there' })
      .expect(201);
    expect(sent.body).toMatchObject({ body: 'hello there', seq: 1, senderId: a.user.id });

    const envelope = (await delivered) as { type: string; payload: { id: string } };
    expect(envelope.type).toBe('message.new');
    expect(envelope.payload.id).toBe(sent.body.id);

    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(b.accessToken))
      .expect(200);
    expect(history.body).toEqual([sent.body]);
  });

  it('does not deliver a message to a socket connected as someone outside the conversation', async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const outsider = await signUpAndLogIn();
    const conversationId = await startDirectConversation(a, b);

    const socketB = new WebSocket(wsUrl(`/realtime?token=${b.accessToken}`));
    const socketOutsider = new WebSocket(wsUrl(`/realtime?token=${outsider.accessToken}`));
    openSockets.push(socketB, socketOutsider);
    await Promise.all([waitForOpen(socketB), waitForOpen(socketOutsider)]);

    const receivedByOutsider: unknown[] = [];
    socketOutsider.on('message', (data: Buffer) =>
      receivedByOutsider.push(JSON.parse(data.toString())),
    );
    // A member's socket waiting for the same broadcast is the positive control: without it, this
    // test would pass just as well if fan-out were completely broken (nobody delivered anything)
    // or if the outsider's socket never actually subscribed.
    const deliveredToMember = waitForMessage(socketB);

    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'c-isolation', body: 'not for you' })
      .expect(201);

    await deliveredToMember;
    expect(receivedByOutsider).toEqual([]);
  });

  it('rejects reusing a clientMsgId across two different conversations with 409, without re-broadcasting', async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const c = await signUpAndLogIn();
    const conversationAB = await startDirectConversation(a, b);
    const conversationAC = await startDirectConversation(a, c);

    await request(server())
      .post(`/conversations/${conversationAB}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'shared-id', body: 'first conversation' })
      .expect(201);

    await request(server())
      .post(`/conversations/${conversationAC}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'shared-id', body: 'second conversation' })
      .expect(409);

    const historyAC = await request(server())
      .get(`/conversations/${conversationAC}/messages`)
      .set(auth(a.accessToken))
      .expect(200);
    expect(historyAC.body).toEqual([]);

    // The dedupe lookup in appendMessage runs before it bumps the conversation's seq counter, so
    // a rejected cross-conversation reuse must not have consumed a seq for AC either -- confirm
    // there's no gap by checking the next real send in AC still lands on seq 1.
    const nextInAC = await request(server())
      .post(`/conversations/${conversationAC}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'unrelated-id', body: 'actually in AC' })
      .expect(201);
    expect(nextInAC.body.seq).toBe(1);
  });

  it('retrying the same clientMsgId returns the original message instead of a duplicate', async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const conversationId = await startDirectConversation(a, b);

    const first = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'retry-1', body: 'take one' })
      .expect(201);
    const retry = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'retry-1', body: 'take one' })
      .expect(201);

    expect(retry.body).toEqual(first.body);

    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .expect(200);
    expect(history.body).toHaveLength(1);
  });

  it("advances the sender's own lastReadSeq, so their own sent message never shows as unread", async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const conversationId = await startDirectConversation(a, b);

    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'c-read', body: 'hello' })
      .expect(201);

    const listForA = await request(server())
      .get('/conversations')
      .set(auth(a.accessToken))
      .expect(200);
    const conv = listForA.body.find((c: { id: string }) => c.id === conversationId);
    expect(conv.lastSeq).toBe(1);
    expect(conv.lastReadSeq).toBe(1);
  });

  it('rejects a non-member reading or posting with 404', async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const outsider = await signUpAndLogIn();
    const conversationId = await startDirectConversation(a, b);

    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(outsider.accessToken))
      .send({ clientMsgId: 'c-x', body: 'sneaky' })
      .expect(404);
    await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(auth(outsider.accessToken))
      .expect(404);
  });

  it('rejects a body over the 4,000 character limit and an empty body', async () => {
    const a = await signUpAndLogIn();
    const b = await signUpAndLogIn();
    const conversationId = await startDirectConversation(a, b);

    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'c-long', body: 'x'.repeat(4001) })
      .expect(400);
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'c-empty', body: '' })
      .expect(400);
  });

  it('requires authentication', async () => {
    await request(server()).get('/conversations/x/messages').expect(401);
    await request(server())
      .post('/conversations/x/messages')
      .send({ clientMsgId: 'c-1', body: 'hi' })
      .expect(401);
  });

  it('returns 404 (not 500) for a conversation id that is not a UUID at all', async () => {
    const a = await signUpAndLogIn();

    await request(server())
      .get('/conversations/not-a-uuid/messages')
      .set(auth(a.accessToken))
      .expect(404);
    await request(server())
      .post('/conversations/not-a-uuid/messages')
      .set(auth(a.accessToken))
      .send({ clientMsgId: 'c-1', body: 'hi' })
      .expect(404);
  });
});

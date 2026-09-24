import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authSessionSchema, makeEnvelope, type AuthSession } from '@videochat/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { createPool } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { MailService } from '../src/mail/mail.service.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
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

interface Node {
  app: INestApplication;
  realtime: RealtimeService;
  mail: FakeMailService;
  wsUrl: (path: string) => string;
}

/** Boots a full AppModule instance listening on its own ephemeral port, standing in for one
 *  node of a horizontally-scaled deployment. Every instance shares the same test Postgres and
 *  Redis (from the environment), which is exactly what makes the Redis pub/sub fan-out under
 *  test meaningful: two instances with no direct connection to each other. */
async function bootNode(): Promise<Node> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useClass(FakeMailService)
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.listen(0);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    app,
    realtime: moduleRef.get(RealtimeService),
    mail: moduleRef.get(MailService) as unknown as FakeMailService,
    wsUrl: (path: string) => `ws://127.0.0.1:${port}${path}`,
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/** `open` fires as soon as the handshake completes, before the gateway's async DB query and
 *  registration with RealtimeService (see handleConnection) finish -- publishing to a
 *  conversation right after `open` can race ahead of that and be silently dropped. The gateway
 *  sends a `realtime.ready` envelope once registration is actually done; waiting for that
 *  instead of (well, in addition to) `open` is what makes this test -- and any real client
 *  relying on the same signal -- deterministic instead of occasionally flaky under load. */
async function waitForReady(ws: WebSocket): Promise<void> {
  await waitForOpen(ws);
  await waitForMessage(ws);
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

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
    ws.once('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe.skipIf(!hasInfra)('realtime gateway fan-out across nodes (CHAT-013)', () => {
  let nodeA: Node;
  let nodeB: Node;
  let userCounter = 0;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    const migrationPool = createPool(process.env.TEST_DATABASE_URL!, 1);
    await resetDatabase(migrationPool);
    await runMigrations(migrationPool);
    await migrationPool.end();

    [nodeA, nodeB] = await Promise.all([bootNode(), bootNode()]);
  });
  afterAll(async () => {
    await Promise.all([nodeA.app.close(), nodeB.app.close()]);
  });
  afterEach(() => {
    for (const ws of openSockets.splice(0)) ws.close();
  });

  async function signUpAndLogIn(node: Node): Promise<AuthSession> {
    userCounter += 1;
    const user = {
      email: `rt-user-${userCounter}@test.dev`,
      username: `rtuser${userCounter}`,
      displayName: `RT User ${userCounter}`,
      password: 'correct-horse-battery-staple',
    };
    await request(node.app.getHttpServer()).post('/auth/signup').send(user).expect(201);
    const token = node.mail.verifyTokens.at(-1)!;
    await request(node.app.getHttpServer()).post('/auth/verify-email').send({ token }).expect(200);
    const res = await request(node.app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return authSessionSchema.parse(res.body);
  }

  function connect(node: Node, accessToken: string): WebSocket {
    const ws = new WebSocket(node.wsUrl(`/realtime?token=${accessToken}`));
    openSockets.push(ws);
    return ws;
  }

  it('delivers a conversation event published on node A to a client connected to node B', async () => {
    const a = await signUpAndLogIn(nodeA);
    const b = await signUpAndLogIn(nodeB);

    // Both users end up members of the same conversation (created via node A's HTTP API);
    // node B's gateway learns that at connect time by reading the same shared database.
    const started = await request(nodeA.app.getHttpServer())
      .post('/conversations/direct')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ userId: b.user.id })
      .expect(201);
    const conversationId = started.body.id as string;

    const socketA = connect(nodeA, a.accessToken);
    const socketB = connect(nodeB, b.accessToken);
    await Promise.all([waitForReady(socketA), waitForReady(socketB)]);

    const envelope = makeEnvelope('message.new', { text: 'hi from node A' }, 'evt-1');
    const received = waitForMessage(socketB);
    // Published from node A's RealtimeService -- socket B is on node A's, and there is no
    // direct connection between the two Nest instances, only the shared Redis they both talk to.
    await nodeA.realtime.publishToConversation(conversationId, envelope);

    expect(await received).toEqual(envelope);
  });

  it('rejects a connection with no access token', async () => {
    const socket = connect(nodeA, '');
    const code = await waitForClose(socket);
    expect(code).toBe(4401);
  });

  it('rejects a connection with an invalid access token', async () => {
    const socket = new WebSocket(nodeA.wsUrl('/realtime?token=not-a-real-token'));
    openSockets.push(socket);
    const code = await waitForClose(socket);
    expect(code).toBe(4401);
  });
});

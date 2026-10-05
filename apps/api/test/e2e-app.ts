import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  authSessionSchema,
  makeEnvelope,
  realtimeReadySchema,
  type AuthSession,
  type WsEnvelope,
} from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { createPool } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { MailService } from '../src/mail/mail.service.js';
import { S3Service } from '../src/storage/s3.service.js';

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
 * In-memory stand-in for object storage (the test infra has Postgres and Redis, no MinIO).
 * Signed URLs point at a fake host; a test "uploads" with `upload(url, bytes)`.
 */
export class FakeS3Service {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  private static readonly HOST = 'https://fake-s3.test/';

  keyFromUrl(url: string): string {
    return decodeURIComponent(new URL(url).pathname.slice(1));
  }
  upload(url: string, body: Buffer, contentType: string): void {
    this.objects.set(this.keyFromUrl(url), { body, contentType });
  }
  putObject(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }
  getSignedPutUrl(key: string, contentType: string) {
    return Promise.resolve({
      url: `${FakeS3Service.HOST}${key}?op=put`,
      headers: { 'Content-Type': contentType },
    });
  }
  getSignedGetUrl(key: string) {
    return Promise.resolve(`${FakeS3Service.HOST}${key}?op=get`);
  }
  getSignedDownloadUrl(key: string, filename: string) {
    return Promise.resolve(
      `${FakeS3Service.HOST}${key}?op=download&name=${encodeURIComponent(filename)}`,
    );
  }
  headObject(key: string) {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.body.length, contentType: o.contentType } : null);
  }
  getObject(key: string) {
    const o = this.objects.get(key);
    return o ? Promise.resolve(o.body) : Promise.reject(new Error(`No object ${key}`));
  }
  deleteObjects(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
    return Promise.resolve();
  }
  getAvatarUrl(avatarKey: string | null) {
    return Promise.resolve(avatarKey ? `${FakeS3Service.HOST}${avatarKey}/256.webp` : null);
  }
}

export interface E2eUser {
  id: string;
  session: AuthSession;
  token: string;
}

/**
 * Shared harness for the M3 call suites: a fresh database, the real AppModule (mail faked), and a
 * server that listens once for the whole file (see the comment in authorization.e2e.spec.ts on why
 * per-request listen/close is avoided). `prefix` keeps generated emails/usernames unique per file.
 */
export async function startE2eApp(prefix: string) {
  const migrationPool = createPool(process.env.TEST_DATABASE_URL!, 1);
  await resetDatabase(migrationPool);
  await runMigrations(migrationPool);
  await migrationPool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useClass(FakeMailService)
    .overrideProvider(S3Service)
    .useClass(FakeS3Service)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const mail = moduleRef.get(MailService) as unknown as FakeMailService;
  const s3 = moduleRef.get(S3Service) as unknown as FakeS3Service;
  const server = () => app.getHttpServer();

  let counter = 0;
  async function signUp(): Promise<E2eUser> {
    counter += 1;
    const user = {
      email: `${prefix}-${counter}@test.dev`,
      username: `${prefix}${counter}`,
      displayName: `${prefix} user ${counter}`,
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
    const me = await request(server()).get('/me').set(bearer(session.accessToken)).expect(200);
    return { id: me.body.id as string, session, token: session.accessToken };
  }

  const port = (app.getHttpServer().address() as AddressInfo).port;
  const sockets: TestSocket[] = [];

  /** Opens a realtime socket as `user` and waits until the gateway has registered it. */
  async function connect(user: E2eUser): Promise<TestSocket> {
    const socket = await TestSocket.open(
      `ws://127.0.0.1:${port}/realtime?token=${encodeURIComponent(user.token)}`,
    );
    sockets.push(socket);
    return socket;
  }

  async function close() {
    for (const s of sockets) s.close();
    await app.close();
  }

  return { app, server, signUp, connect, close, s3 };
}

/**
 * A realtime client for tests: buffers every envelope it receives, so a test can wait for one
 * that may already have arrived, and assert that something did *not* arrive.
 */
export class TestSocket {
  readonly received: WsEnvelope[] = [];
  private waiters: Array<() => void> = [];
  connectionId = '';

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.received.push(JSON.parse(data.toString()) as WsEnvelope);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static async open(url: string): Promise<TestSocket> {
    const socket = new TestSocket(new WebSocket(url));
    const ready = await socket.waitFor('realtime.ready');
    socket.connectionId = realtimeReadySchema.parse(ready.payload).connectionId;
    return socket;
  }

  send(type: string, payload: unknown): void {
    this.ws.send(JSON.stringify(makeEnvelope(type, payload, randomUUID())));
  }

  /** Resolves with the first received envelope of `type` matching `where`, waiting if needed. */
  waitFor(
    type: string,
    where: (payload: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 8000,
  ): Promise<WsEnvelope> {
    const find = () =>
      this.received.find((e) => e.type === type && where(e.payload as Record<string, unknown>));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
      const check = () => {
        const hit = find();
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        } else {
          this.waiters.push(check);
        }
      };
      check();
    });
  }

  /** Asserts nothing of `type` (matching `where`) arrives within `ms`. */
  async expectNone(
    type: string,
    where: (payload: Record<string, unknown>) => boolean = () => true,
    ms = 400,
  ): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const hit = this.received.find(
      (e) => e.type === type && where(e.payload as Record<string, unknown>),
    );
    if (hit) throw new Error(`Unexpected ${type}: ${JSON.stringify(hit.payload)}`);
  }

  close(): void {
    this.ws.close();
  }
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

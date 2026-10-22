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
import { loadEnv, type Env } from '../src/config/env.js';
import { ENV } from '../src/infra/tokens.js';
import { createPool } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { MailService } from '../src/mail/mail.service.js';
import { ObjectTooLargeError, S3Service } from '../src/storage/s3.service.js';
import { LinkPreviewFetcher } from '../src/link-previews/link-preview.fetcher.js';
import { WebPushChannel } from '../src/notifications/web-push.channel.js';
import { SFU, type Sfu, type SfuRoom } from '../src/group-calls/sfu.js';

export class FakeMailService {
  verifyTokens: string[] = [];
  sendVerificationEmail(_to: string, token: string) {
    this.verifyTokens.push(token);
    return Promise.resolve();
  }
  sendPasswordResetEmail() {
    return Promise.resolve();
  }
  /** CHAT-081 */
  loginLinks: Array<{ to: string; token: string; code: string }> = [];
  sendLoginLinkEmail(to: string, token: string, code: string) {
    this.loginLinks.push({ to, token, code });
    return Promise.resolve();
  }
  /** CHAT-077 */
  notices: Array<{ to: string; kind: string }> = [];
  sendModerationNotice(to: string, notice: { kind: string }) {
    this.notices.push({ to, kind: notice.kind });
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
  getObject(key: string, maxBytes?: number) {
    const o = this.objects.get(key);
    if (!o) return Promise.reject(new Error(`No object ${key}`));
    if (maxBytes !== undefined && o.body.length > maxBytes) {
      return Promise.reject(new ObjectTooLargeError(key));
    }
    return Promise.resolve(o.body);
  }
  copyObject(fromKey: string, toKey: string, contentType: string) {
    const o = this.objects.get(fromKey);
    if (!o) return Promise.reject(new Error(`No object ${fromKey}`));
    this.objects.set(toKey, { body: o.body, contentType });
    return Promise.resolve();
  }
  deleteObjects(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
    return Promise.resolve();
  }
  getAvatarUrl(avatarKey: string | null) {
    return Promise.resolve(avatarKey ? `${FakeS3Service.HOST}${avatarKey}/256.webp` : null);
  }
}

/** No outbound HTTP in tests: any URL on `preview.test` gets a fixed preview, others none. */
export class FakeLinkPreviewFetcher {
  calls: string[] = [];
  fetchPreview(url: string) {
    this.calls.push(url);
    if (!new URL(url).hostname.endsWith('preview.test')) return Promise.resolve(null);
    return Promise.resolve({
      url,
      title: 'Preview title',
      description: 'Preview description',
      siteName: 'Preview Site',
      imageUrl: 'https://preview.test/og.png',
    });
  }
}

/** Records pushes instead of sending them; an endpoint containing "gone" acts expired. */
export class FakePushChannel {
  readonly platform = 'web' as const;
  readonly enabled = true;
  readonly publicKey = 'BFakeVapidPublicKey';
  sent: Array<{
    endpoint: string;
    payload: { title: string; body: string; conversationId: string };
  }> = [];
  send(
    device: { token: string },
    payload: { title: string; body: string; conversationId: string },
  ) {
    if (device.token.includes('gone')) return Promise.resolve('gone' as const);
    this.sent.push({ endpoint: device.token, payload });
    return Promise.resolve('sent' as const);
  }
}

/** CHAT-070: an in-memory SFU. A test puts people "in" a room with `setParticipants`, or removes
 *  the room (everyone left and the SFU closed it) with `closeRoom`. */
export class FakeSfu implements Sfu {
  enabled = true;
  readonly url = 'wss://sfu.test';
  readonly rooms = new Map<string, number>();
  readonly tokens: Array<{ room: string; identity: string; name: string }> = [];
  readonly removed: Array<{ room: string; identity: string }> = [];
  /** Who is "connected" to each room (a test connects issued tokens with `connect`). */
  readonly connected = new Map<string, Set<string>>();
  readonly creates: string[] = [];
  failCreate = false;

  createRoom(name: string) {
    if (this.failCreate) return Promise.reject(new Error('SFU down'));
    this.creates.push(name);
    if (!this.rooms.has(name)) this.rooms.set(name, 0);
    return Promise.resolve();
  }
  listRooms(names: string[]): Promise<SfuRoom[]> {
    return Promise.resolve(
      names
        .filter((n) => this.rooms.has(n))
        .map((n) => ({ name: n, numParticipants: this.rooms.get(n)! })),
    );
  }
  joinToken(room: string, identity: string, name: string) {
    this.tokens.push({ room, identity, name });
    return Promise.resolve(`token-${room}-${identity}`);
  }
  listIdentities(room: string) {
    return Promise.resolve([...(this.connected.get(room) ?? [])]);
  }
  readonly deleted: string[] = [];
  deleteRoom(room: string) {
    this.deleted.push(room);
    this.rooms.delete(room);
    this.connected.delete(room);
    return Promise.resolve();
  }
  removeIdentity(room: string, identity: string) {
    this.removed.push({ room, identity });
    this.connected.get(room)?.delete(identity);
    return Promise.resolve();
  }
  /** Connects the holder of every token issued for `room` (for `userId` only, if given). */
  connect(room: string, userId?: string) {
    const set = this.connected.get(room) ?? new Set<string>();
    for (const t of this.tokens) {
      if (t.room === room && (!userId || t.identity.startsWith(`${userId}:`))) set.add(t.identity);
    }
    this.connected.set(room, set);
    this.rooms.set(room, set.size);
  }
  removedUsers(room: string) {
    return this.removed.filter((r) => r.room === room).map((r) => r.identity.split(':')[0]);
  }
  setParticipants(room: string, count: number) {
    this.rooms.set(room, count);
  }
  closeRoom(room: string) {
    this.rooms.delete(room);
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
export async function startE2eApp(prefix: string, envOverrides: Partial<Env> = {}) {
  const migrationPool = createPool(process.env.TEST_DATABASE_URL!, 1);
  await resetDatabase(migrationPool);
  await runMigrations(migrationPool);
  await migrationPool.end();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useClass(FakeMailService)
    .overrideProvider(S3Service)
    .useClass(FakeS3Service)
    .overrideProvider(LinkPreviewFetcher)
    .useClass(FakeLinkPreviewFetcher)
    .overrideProvider(WebPushChannel)
    .useClass(FakePushChannel)
    .overrideProvider(SFU)
    .useClass(FakeSfu)
    .overrideProvider(ENV)
    .useValue({ ...loadEnv(), ...envOverrides })
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const mail = moduleRef.get(MailService) as unknown as FakeMailService;
  const s3 = moduleRef.get(S3Service) as unknown as FakeS3Service;
  const push = moduleRef.get(WebPushChannel) as unknown as FakePushChannel;
  const sfu = moduleRef.get<FakeSfu>(SFU);
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

  return { app, server, signUp, connect, close, s3, push, sfu, moduleRef };
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

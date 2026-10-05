import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDb, createPool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { PresenceService } from '../src/realtime/presence.service.js';
import { bearer, startE2eApp, type E2eUser, type TestSocket } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('presence (CHAT-034)', () => {
  let app: INestApplication;
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;

  beforeAll(async () => {
    ({ app, server, signUp, connect, close: closeAll } = await startE2eApp('pr'));
  });
  afterAll(() => closeAll());

  async function direct(a: E2eUser, b: E2eUser) {
    await request(server())
      .post('/conversations/direct')
      .set(bearer(a.token))
      .send({ userId: b.id })
      .expect(201);
  }
  const presenceOf = async (viewer: E2eUser, ids: string[]) =>
    (
      await request(server())
        .get('/presence')
        .query({ userIds: ids.join(',') })
        .set(bearer(viewer.token))
        .expect(200)
    ).body as Array<{ userId: string; online: boolean; lastSeenAt: string | null }>;

  async function setVisibility(user: E2eUser, value: 'everyone' | 'contacts' | 'nobody') {
    const pool = createPool(process.env.TEST_DATABASE_URL!, 1);
    try {
      await createDb(pool)
        .update(users)
        .set({ lastSeenVisibility: value })
        .where(eq(users.id, user.id));
    } finally {
      await pool.end();
    }
  }

  it('goes online with the first connection, stays online across tabs, offline with the last', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    await direct(anna, ben);
    const annaWatch = await connect(anna);
    expect(await presenceOf(anna, [ben.id])).toEqual([
      { userId: ben.id, online: false, lastSeenAt: null },
    ]);

    const tab1 = await connect(ben);
    await annaWatch.waitFor('presence.changed', (p) => p.userId === ben.id && p.online === true);
    const tab2 = await connect(ben);
    tab1.close();
    await annaWatch.expectNone(
      'presence.changed',
      (p) => p.userId === ben.id && p.online === false,
      400,
    );
    expect((await presenceOf(anna, [ben.id]))[0]!.online).toBe(true);

    tab2.close();
    const offline = await annaWatch.waitFor(
      'presence.changed',
      (p) => p.userId === ben.id && p.online === false,
    );
    expect(offline.payload).toMatchObject({ lastSeenAt: expect.any(String) });
    expect((await presenceOf(anna, [ben.id]))[0]).toMatchObject({
      online: false,
      lastSeenAt: expect.any(String),
    });
  });

  it('marks a user offline when their connections lapse without a clean close', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    await direct(anna, ben);
    const presence = app.get(PresenceService);
    await presence.connected(ben.id, 'ghost-connection', Date.now());
    expect((await presenceOf(anna, [ben.id]))[0]!.online).toBe(true);
    // 61 s later, nothing refreshed it.
    await presence.sweep(Date.now() + 61_000);
    expect((await presenceOf(anna, [ben.id]))[0]!.online).toBe(false);
  });

  it('respects privacy: hidden subjects, contacts-only, and viewers who hide their own', async () => {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    await direct(anna, ben);
    // Clara only shares a group with Anna.
    await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'G', memberIds: [clara.id] })
      .expect(201);
    const outsider = await signUp();

    expect((await presenceOf(outsider, [anna.id])).length).toBe(0);
    await setVisibility(anna, 'contacts');
    expect((await presenceOf(ben, [anna.id])).length).toBe(1);
    expect((await presenceOf(clara, [anna.id])).length).toBe(0);
    await setVisibility(anna, 'everyone');
    expect((await presenceOf(clara, [anna.id])).length).toBe(1);
    await setVisibility(clara, 'nobody');
    expect((await presenceOf(clara, [anna.id])).length).toBe(0);
  });
});

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
    const lastRefresh = Date.now();
    await presence.connected(ben.id, 'ghost-connection', lastRefresh);
    expect((await presenceOf(anna, [ben.id]))[0]!.online).toBe(true);
    // 61 s later, nothing refreshed it.
    await presence.sweep(lastRefresh + 61_000);
    // Last seen is the last refresh, not the sweep time minus the TTL.
    expect((await presenceOf(anna, [ben.id]))[0]).toEqual({
      userId: ben.id,
      online: false,
      lastSeenAt: new Date(lastRefresh).toISOString(),
    });
  });

  const lastPresence = (socket: TestSocket, userId: string) =>
    socket.received
      .filter((e) => e.type === 'presence.changed')
      .map((e) => e.payload as { userId: string; online: boolean })
      .filter((p) => p.userId === userId)
      .at(-1);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('a reload (close one socket, open another) never leaves the user offline', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    await direct(anna, ben);
    const annaWatch = await connect(anna);
    const presence = app.get(PresenceService);

    // New connection registered before the old one closes: no transition at all.
    await presence.connected(ben.id, 'old');
    await annaWatch.waitFor('presence.changed', (p) => p.userId === ben.id && p.online === true);
    await presence.connected(ben.id, 'new');
    await presence.disconnected(ben.id, 'old');
    await annaWatch.expectNone(
      'presence.changed',
      (p) => p.userId === ben.id && p.online === false,
      300,
    );

    // The review's interleaving: the reconnect lands after the close took Ben offline but before
    // the offline announcement goes out. Contacts must end on "online".
    const target = presence as unknown as {
      announceOffline?: (userId: string, at: Date) => Promise<void>;
    };
    const real = target.announceOffline!.bind(presence);
    target.announceOffline = async (userId, at) => {
      await presence.connected(ben.id, 'reloaded');
      await real(userId, at);
    };
    try {
      await presence.disconnected(ben.id, 'new');
    } finally {
      delete target.announceOffline; // back to the prototype's
    }
    await settle();
    expect(lastPresence(annaWatch, ben.id)).toMatchObject({ online: true });
    expect((await presenceOf(anna, [ben.id]))[0]!.online).toBe(true);

    // And a burst of concurrent close/open pairs ends online too.
    let current = 'reloaded';
    for (let i = 0; i < 10; i++) {
      const next = `tab-${i}`;
      await Promise.all([presence.disconnected(ben.id, current), presence.connected(ben.id, next)]);
      current = next;
    }
    await settle();
    expect(lastPresence(annaWatch, ben.id)).toMatchObject({ online: true });
    expect((await presenceOf(anna, [ben.id]))[0]!.online).toBe(true);
  });

  it('hides presence both ways once either side blocks', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    await direct(anna, ben);
    await request(server()).post(`/users/${ben.id}/block`).set(bearer(anna.token)).expect(200);
    expect(await presenceOf(anna, [ben.id])).toEqual([]);
    expect(await presenceOf(ben, [anna.id])).toEqual([]);

    const [annaWatch, benWatch] = [await connect(anna), await connect(ben)];
    await settle();
    expect(lastPresence(annaWatch, ben.id)).toBeUndefined();
    expect(lastPresence(benWatch, anna.id)).toBeUndefined();

    await request(server()).delete(`/users/${ben.id}/block`).set(bearer(anna.token)).expect(200);
    expect((await presenceOf(ben, [anna.id]))[0]!.online).toBe(true);
  });

  it('sends presence.changed only to viewers allowed to see it, and not to members who left', async () => {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    await direct(anna, ben);
    const group = await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'G', memberIds: [clara.id] })
      .expect(201);
    const [benWatch, claraWatch] = [await connect(ben), await connect(clara)];

    // Contacts-only: Ben (direct) hears it, Clara (group only) doesn't.
    await setVisibility(anna, 'contacts');
    const tab = await connect(anna);
    await benWatch.waitFor('presence.changed', (p) => p.userId === anna.id && p.online === true);
    await claraWatch.expectNone('presence.changed', (p) => p.userId === anna.id, 300);
    tab.close();
    await benWatch.waitFor('presence.changed', (p) => p.userId === anna.id && p.online === false);

    // Everyone: Clara hears it -- until she leaves the only conversation they shared.
    await setVisibility(anna, 'everyone');
    const tab2 = await connect(anna);
    await claraWatch.waitFor('presence.changed', (p) => p.userId === anna.id && p.online === true);
    await request(server())
      .post(`/conversations/${group.body.id as string}/leave`)
      .set(bearer(clara.token))
      .expect((r) => expect(r.status).toBeLessThan(300));
    tab2.close();
    await settle();
    expect(lastPresence(claraWatch, anna.id)).toMatchObject({ online: true });
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
    // Reciprocal: Clara shares hers with contacts only, and Anna isn't one.
    await setVisibility(clara, 'contacts');
    expect((await presenceOf(clara, [anna.id])).length).toBe(0);
    await setVisibility(clara, 'nobody');
    expect((await presenceOf(clara, [anna.id])).length).toBe(0);
  });
});

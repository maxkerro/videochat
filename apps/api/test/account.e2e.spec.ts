import type { INestApplication } from '@nestjs/common';
import { authSessionSchema } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type TestSocket } from './e2e-app.js';
import { hasInfra } from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

describe.skipIf(!hasInfra)('settings and account (CHAT-037)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll } = await startE2eApp('acct'));
  });
  afterAll(() => closeAll());

  async function direct(a: E2eUser, b: E2eUser) {
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(a.token))
      .send({ userId: b.id })
      .expect(201);
    return res.body.id as string;
  }
  const me = async (u: E2eUser) =>
    (await request(server()).get('/me').set(bearer(u.token)).expect(200)).body;

  it('saves settings, returns them on /me and pushes them to the other devices', async () => {
    const anna = await signUp();
    expect((await me(anna)).settings).toEqual({
      readReceipts: true,
      lastSeenVisibility: 'everyone',
      notifications: { enabled: true, sound: true, previews: true },
      theme: 'system',
    });
    const otherDevice = await connect(anna);
    const res = await request(server())
      .patch('/me/settings')
      .set(bearer(anna.token))
      .send({ theme: 'dark', notifications: { previews: false } })
      .expect(200);
    expect(res.body.settings).toMatchObject({
      theme: 'dark',
      notifications: { enabled: true, sound: true, previews: false },
    });
    await otherDevice.waitFor(
      'me.updated',
      (p) => (p.settings as { theme: string }).theme === 'dark',
    );
  });

  it("read receipts off: others don't see your reads (and the read event stays on your devices)", async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await direct(anna, ben);
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), body: 'hi' })
      .expect(201);
    await request(server())
      .patch('/me/settings')
      .set(bearer(ben.token))
      .send({ readReceipts: false })
      .expect(200);
    const annaSocket = await connect(anna);
    await request(server())
      .post(`/conversations/${conversationId}/read`)
      .set(bearer(ben.token))
      .send({ seq: 1 })
      .expect(201);
    await annaSocket.expectNone('conversation.read', (p) => p.userId === ben.id, 500);
    const forAnna = await request(server())
      .get(`/conversations/${conversationId}`)
      .set(bearer(anna.token))
      .expect(200);
    expect(forAnna.body.peerLastReadSeq).toBe(0);
  });

  it('changes the password with the current one, keeping this session and ending others', async () => {
    const anna = await signUp();
    const meRes = await me(anna);
    // A second session (another device).
    const second = await request(server())
      .post('/auth/login')
      .send({ identifier: meRes.email, password: PASSWORD })
      .expect(200);
    const secondCookie = (second.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;

    await request(server())
      .post('/auth/change-password')
      .set(bearer(anna.token))
      .send({ currentPassword: 'wrong-password', newPassword: 'a-new-long-password' })
      .expect(400);
    await request(server())
      .post('/auth/change-password')
      .set(bearer(anna.token))
      .send({ currentPassword: PASSWORD, newPassword: 'a-new-long-password' })
      .expect(204);

    await request(server())
      .post('/auth/refresh')
      .set('Cookie', secondCookie.split(';')[0]!)
      .expect(401);
    await request(server())
      .post('/auth/login')
      .send({ identifier: meRes.email, password: PASSWORD })
      .expect(401);
    const fresh = await request(server())
      .post('/auth/login')
      .send({ identifier: meRes.email, password: 'a-new-long-password' })
      .expect(200);
    authSessionSchema.parse(fresh.body);
  });

  it('exports your messages as a JSON file', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await direct(anna, ben);
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), body: 'mine' })
      .expect(201);
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .send({ clientMsgId: randomUUID(), body: 'not mine' })
      .expect(201);
    const res = await request(server()).get('/me/export').set(bearer(anna.token)).expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="videochat-export-/);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['mine']);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.profile.id).toBe(anna.id);
  });

  it('deletes the account after the password: content erased, can no longer log in', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const conversationId = await direct(anna, ben);
    const email = (await me(anna)).email as string;
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), body: 'my secret' })
      .expect(201);

    await request(server())
      .post('/auth/delete-account')
      .set(bearer(anna.token))
      .send({ password: 'nope' })
      .expect(400);
    await request(server())
      .post('/auth/delete-account')
      .set(bearer(anna.token))
      .send({ password: PASSWORD })
      .expect(204);

    await request(server())
      .post('/auth/login')
      .send({ identifier: email, password: PASSWORD })
      .expect(401);
    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    expect(history.body.messages.at(-1)).toMatchObject({ body: null });
    const found = await request(server())
      .get('/users/search')
      .query({ q: email })
      .set(bearer(ben.token))
      .expect(200);
    expect(found.body.users).toHaveLength(0);
  });
});

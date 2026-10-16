import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type FakePushChannel } from './e2e-app.js';
import { hasInfra } from './helpers.js';

/** CHAT-076 (spike): the key directory and encrypted messages. The server treats key packages,
 *  welcomes and ciphertext as opaque base64, so these tests use stand-in bytes; the real MLS flow
 *  is covered by the web client's tests. */
describe.skipIf(!hasInfra)('end-to-end encryption prototype (CHAT-076)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  let push: FakePushChannel;

  beforeAll(async () => {
    ({ server, signUp, close: closeAll, push } = await startE2eApp('ee', { E2EE_PROTOTYPE: true }));
  });
  afterAll(() => closeAll());

  const b64 = (s: string) => Buffer.from(s).toString('base64');

  async function register(user: E2eUser, n = 2): Promise<string> {
    const res = await request(server())
      .post('/e2ee/devices')
      .set(bearer(user.token))
      .send({})
      .expect(201);
    expect(res.body.userId).toBe(user.id);
    const deviceId = res.body.deviceId as string;
    const up = await request(server())
      .post(`/e2ee/devices/${deviceId}/key-packages`)
      .set(bearer(user.token))
      .send({ keyPackages: Array.from({ length: n }, (_, i) => b64(`kp-${user.id}-${i}`)) })
      .expect(201);
    expect(up.body.count).toBe(n);
    // Only the owner can top up a device.
    const other = await signUp();
    await request(server())
      .post(`/e2ee/devices/${deviceId}/key-packages`)
      .set(bearer(other.token))
      .send({ keyPackages: [b64('x')] })
      .expect(403);
    return deviceId;
  }

  async function dm(a: E2eUser, b: E2eUser): Promise<string> {
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(a.token))
      .send({ userId: b.id })
      .expect((r) => expect([200, 201]).toContain(r.status));
    return res.body.id as string;
  }

  it('reports that the prototype is on', async () => {
    const user = await signUp();
    const res = await request(server()).get('/e2ee/status').set(bearer(user.token)).expect(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('hands out each key package once, to members only, and runs the welcome flow', async () => {
    const [anna, ben, outsider] = [await signUp(), await signUp(), await signUp()];
    const annaDevice = await register(anna);
    const benPhone = await register(ben, 1);
    const benLaptop = await register(ben, 1);
    await register(outsider);
    const conversationId = await dm(anna, ben);

    // Outsiders can't claim keys for the chat, or use someone else's device id.
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/key-packages/claim`)
      .set(bearer(outsider.token))
      .send({ deviceId: annaDevice })
      .expect(403);

    const claim = await request(server())
      .post(`/e2ee/conversations/${conversationId}/key-packages/claim`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice })
      .expect(200);
    expect(claim.body.keyPackages.map((k: { deviceId: string }) => k.deviceId).sort()).toEqual(
      [benPhone, benLaptop].sort(),
    );
    expect(claim.body.missing).toEqual([]);

    // One-time: the next claim finds Ben's devices empty.
    const again = await request(server())
      .post(`/e2ee/conversations/${conversationId}/key-packages/claim`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice })
      .expect(200);
    expect(again.body.keyPackages).toEqual([]);
    expect(again.body.missing).toHaveLength(2);

    // No group yet: encrypted sends are refused.
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), e2ee: { v: 1, ciphertext: b64('x') } })
      .expect(400);

    // Welcomes may only go to devices in the chat.
    const outsiderDevice = await register(outsider, 1);
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice, welcomes: [{ deviceId: outsiderDevice, welcome: b64('w') }] })
      .expect(400);

    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(anna.token))
      .send({
        deviceId: annaDevice,
        welcomes: [
          { deviceId: benPhone, welcome: b64('welcome-phone') },
          { deviceId: benLaptop, welcome: b64('welcome-laptop') },
        ],
      })
      .expect(201);

    // The second creator loses the race.
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(ben.token))
      .send({ deviceId: benPhone, welcomes: [] })
      .expect(409);

    const group = await request(server())
      .get(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(ben.token))
      .expect(200);
    expect(group.body.group.creatorDeviceId).toBe(annaDevice);

    // Ben's phone picks up only its own welcome; Anna can't read it.
    await request(server())
      .get(`/e2ee/welcomes?deviceId=${benPhone}`)
      .set(bearer(anna.token))
      .expect(403);
    const welcomes = await request(server())
      .get(`/e2ee/welcomes?deviceId=${benPhone}`)
      .set(bearer(ben.token))
      .expect(200);
    expect(welcomes.body.welcomes).toHaveLength(1);
    expect(welcomes.body.welcomes[0]).toMatchObject({
      conversationId,
      senderDeviceId: annaDevice,
      welcome: b64('welcome-phone'),
    });
    const welcomeId = welcomes.body.welcomes[0].id as string;
    await request(server())
      .delete(`/e2ee/welcomes/${welcomeId}`)
      .set(bearer(anna.token))
      .expect(404);
    await request(server())
      .delete(`/e2ee/welcomes/${welcomeId}`)
      .set(bearer(ben.token))
      .expect(204);
    const after = await request(server())
      .get(`/e2ee/welcomes?deviceId=${benPhone}`)
      .set(bearer(ben.token))
      .expect(200);
    expect(after.body.welcomes).toEqual([]);
  });

  it('keeps outsiders, blocked people and group chats out, and stops claims once a group exists', async () => {
    const [anna, ben, outsider] = [await signUp(), await signUp(), await signUp()];
    const annaDevice = await register(anna);
    await register(ben, 3);
    const outsiderDevice = await register(outsider);
    const conversationId = await dm(anna, ben);

    // An outsider with their own, valid device is still not a member.
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/key-packages/claim`)
      .set(bearer(outsider.token))
      .send({ deviceId: outsiderDevice })
      .expect(404);
    await request(server())
      .get(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(outsider.token))
      .expect(404);
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(outsider.token))
      .send({ deviceId: outsiderDevice, welcomes: [] })
      .expect(404);

    // Group chats aren't in the prototype.
    const group = await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'Team', memberIds: [ben.id] })
      .expect(201);
    await request(server())
      .post(`/e2ee/conversations/${group.body.id}/key-packages/claim`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice })
      .expect(400);

    // Once the chat has a group, nobody can drain the other person's one-time keys through it.
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice, welcomes: [] })
      .expect(201);
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/key-packages/claim`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice })
      .expect(409);

    // A block either way stops claims too.
    const [clara, dan] = [await signUp(), await signUp()];
    const claraDevice = await register(clara);
    await register(dan);
    const blockedDm = await dm(clara, dan);
    await request(server()).post(`/users/${clara.id}/block`).set(bearer(dan.token)).expect(200);
    await request(server())
      .post(`/e2ee/conversations/${blockedDm}/key-packages/claim`)
      .set(bearer(clara.token))
      .send({ deviceId: claraDevice })
      .expect(403);
  });

  it('caps devices per account, and forgets a deleted account’s devices', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const annaDevice = await register(anna);
    for (let i = 0; i < 10; i++) {
      await request(server()).post('/e2ee/devices').set(bearer(ben.token)).send({}).expect(201);
    }
    await request(server()).post('/e2ee/devices').set(bearer(ben.token)).send({}).expect(409);

    const conversationId = await dm(anna, ben);
    await request(server())
      .post('/auth/delete-account')
      .set(bearer(ben.token))
      .send({ password: 'correct-horse-battery-staple' })
      .expect(204);
    const claim = await request(server())
      .post(`/e2ee/conversations/${conversationId}/key-packages/claim`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice })
      .expect(200);
    expect(claim.body).toEqual({ keyPackages: [], missing: [] });
  });

  it('stores and relays ciphertext only: no body, no link preview, no text in the push', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const annaDevice = await register(anna, 1);
    const benDevice = await register(ben, 1);
    const conversationId = await dm(anna, ben);
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(anna.token))
      .send({ deviceId: annaDevice, welcomes: [{ deviceId: benDevice, welcome: b64('w') }] })
      .expect(201);

    const endpoint = `https://push.example/${randomUUID()}`;
    await request(server())
      .post('/push/subscriptions')
      .set(bearer(ben.token))
      .send({ endpoint, keys: { p256dh: 'BAbc', auth: 'xyz' } })
      .expect(204);

    const ciphertext = b64('opaque https://secret.example bytes');
    const sent = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), e2ee: { v: 1, ciphertext } })
      .expect(201);
    expect(sent.body.body).toBeNull();
    expect(sent.body.e2ee).toEqual({ v: 1, ciphertext });

    // Can't mix plain text into an encrypted message, and can't edit one.
    await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), body: 'leak', e2ee: { v: 1, ciphertext } })
      .expect(400);
    await request(server())
      .patch(`/conversations/${conversationId}/messages/${sent.body.id}`)
      .set(bearer(anna.token))
      .send({ body: 'edited' })
      .expect(400);

    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    expect(history.body.messages.at(-1)).toMatchObject({ body: null, e2ee: { v: 1, ciphertext } });

    const list = await request(server()).get('/conversations').set(bearer(ben.token)).expect(200);
    const summary = list.body.find((c: { id: string }) => c.id === conversationId);
    expect(summary.lastMessage).toMatchObject({ body: null, encrypted: true });

    await new Promise((r) => setTimeout(r, 300));
    const pushes = push.sent.filter((s) => s.endpoint === endpoint);
    expect(pushes.length).toBeGreaterThan(0);
    expect(JSON.stringify(pushes)).not.toContain('secret.example');
  });
});

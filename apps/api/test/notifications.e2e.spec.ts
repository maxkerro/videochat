import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bearer,
  startE2eApp,
  type E2eUser,
  type FakePushChannel,
  type TestSocket,
} from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('push notifications (CHAT-035)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;
  let push: FakePushChannel;

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll, push } = await startE2eApp('np'));
  });
  afterAll(() => closeAll());

  async function setUp() {
    const [anna, ben] = [await signUp(), await signUp()];
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: ben.id })
      .expect(201);
    const endpoint = `https://push.example/${randomUUID()}`;
    await request(server())
      .post('/push/subscriptions')
      .set(bearer(ben.token))
      .send({ endpoint, keys: { p256dh: 'BAbc', auth: 'xyz' } })
      .expect(204);
    return { anna, ben, conversationId: res.body.id as string, endpoint };
  }

  const send = (user: E2eUser, conversationId: string, body: string) =>
    request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(user.token))
      .send({ clientMsgId: randomUUID(), body })
      .expect(201);

  const sentTo = (endpoint: string) => push.sent.filter((s) => s.endpoint === endpoint);
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it('exposes the VAPID key and pushes a new message to the other member', async () => {
    const key = await request(server()).get('/push/vapid-public-key').expect(200);
    expect(key.body.publicKey).toBe('BFakeVapidPublicKey');

    const { anna, conversationId, endpoint } = await setUp();
    await send(anna, conversationId, 'Are you coming?');
    await settle();
    expect(sentTo(endpoint)).toEqual([
      {
        endpoint,
        payload: expect.objectContaining({
          body: 'Are you coming?',
          conversationId,
          url: `/c/${conversationId}`,
        }),
      },
    ]);
  });

  it("doesn't push the conversation you're looking at, but does once you look away", async () => {
    const { anna, ben, conversationId, endpoint } = await setUp();
    const tab = await connect(ben);
    tab.send('client.viewing', { conversationId });
    await settle();
    await send(anna, conversationId, 'seen live');
    await settle();
    expect(sentTo(endpoint)).toHaveLength(0);

    tab.send('client.viewing', { conversationId: null });
    await settle();
    await send(anna, conversationId, 'now push');
    await settle();
    expect(sentTo(endpoint).map((s) => s.payload.body)).toEqual(['now push']);
  });

  it('never notifies a muted conversation', async () => {
    const { anna, ben, conversationId, endpoint } = await setUp();
    const muted = await request(server())
      .put(`/conversations/${conversationId}/mute`)
      .set(bearer(ben.token))
      .send({ muted: true })
      .expect(200);
    expect(muted.body.muted).toBe(true);
    await send(anna, conversationId, 'shh');
    await settle();
    expect(sentTo(endpoint)).toHaveLength(0);

    await request(server())
      .put(`/conversations/${conversationId}/mute`)
      .set(bearer(ben.token))
      .send({ muted: false })
      .expect(200);
    await send(anna, conversationId, 'loud');
    await settle();
    expect(sentTo(endpoint)).toHaveLength(1);
  });

  it('drops an expired subscription and lets you unsubscribe', async () => {
    const { anna, ben, conversationId } = await setUp();
    const gone = `https://push.example/gone-${randomUUID()}`;
    await request(server())
      .post('/push/subscriptions')
      .set(bearer(ben.token))
      .send({ endpoint: gone, keys: { p256dh: 'B', auth: 'a' } })
      .expect(204);
    await send(anna, conversationId, 'one');
    await settle();
    await request(server())
      .delete('/push/subscriptions')
      .set(bearer(ben.token))
      .send({ endpoint: gone })
      .expect(204);
    await request(server())
      .post('/push/subscriptions')
      .send({ endpoint: gone, keys: { p256dh: 'B', auth: 'a' } })
      .expect(401);
  });
});

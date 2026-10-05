import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type TestSocket } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('link previews (CHAT-031)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll } = await startE2eApp('lp'));
  });
  afterAll(() => closeAll());

  async function setUp() {
    const [anna, ben] = [await signUp(), await signUp()];
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: ben.id })
      .expect(201);
    return { anna, ben, conversationId: res.body.id as string, benSocket: await connect(ben) };
  }

  function send(user: E2eUser, conversationId: string, body: object) {
    return request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(user.token))
      .send({ clientMsgId: randomUUID(), ...body })
      .expect(201);
  }

  it('adds a preview after sending, announced as message.updated and kept in history', async () => {
    const { anna, ben, conversationId, benSocket } = await setUp();
    const sent = await send(anna, conversationId, {
      body: 'look at https://www.preview.test/page.',
    });
    expect(sent.body.linkPreview).toBeUndefined(); // the send itself never waits for it

    const updated = await benSocket.waitFor('message.updated', (p) => p.id === sent.body.id);
    expect(updated.payload).toMatchObject({
      linkPreview: { url: 'https://www.preview.test/page', title: 'Preview title' },
    });
    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    expect(history.body.messages.at(-1).linkPreview.title).toBe('Preview title');
  });

  it('skips the preview when the sender dismissed it before sending', async () => {
    const { anna, conversationId, benSocket } = await setUp();
    const sent = await send(anna, conversationId, {
      body: 'https://www.preview.test/no',
      linkPreview: false,
    });
    await benSocket.expectNone('message.updated', (p) => p.id === sent.body.id, 500);
  });

  it('lets only the sender remove it after sending', async () => {
    const { anna, ben, conversationId, benSocket } = await setUp();
    const sent = await send(anna, conversationId, { body: 'https://www.preview.test/rm' });
    await benSocket.waitFor('message.updated', (p) => p.id === sent.body.id && !!p.linkPreview);

    const path = `/conversations/${conversationId}/messages/${sent.body.id}/link-preview`;
    await request(server()).delete(path).set(bearer(ben.token)).expect(403);
    await request(server()).delete(path).set(bearer(anna.token)).expect(204);
    const removed = await benSocket.waitFor(
      'message.updated',
      (p) => p.id === sent.body.id && p.linkPreview === undefined,
    );
    expect(removed.payload).not.toHaveProperty('linkPreview');
  });

  it('serves the composer preview, and refuses a non-URL', async () => {
    const { anna } = await setUp();
    const res = await request(server())
      .get('/link-preview')
      .query({ url: 'https://preview.test/x' })
      .set(bearer(anna.token))
      .expect(200);
    expect(res.body.preview.siteName).toBe('Preview Site');
    const none = await request(server())
      .get('/link-preview')
      .query({ url: 'https://elsewhere.test/' })
      .set(bearer(anna.token))
      .expect(200);
    expect(none.body.preview).toBeNull();
    await request(server())
      .get('/link-preview')
      .query({ url: 'javascript:alert(1)' })
      .set(bearer(anna.token))
      .expect(400);
  });
});

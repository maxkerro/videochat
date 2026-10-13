import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createPool } from '../src/db/client.js';
import { bearer, startE2eApp, type E2eUser } from './e2e-app.js';
import { hasInfra } from './helpers.js';

/** CHAT-058: reporting a message (the report mechanism the app stores require). */
describe.skipIf(!hasInfra)('report a message (CHAT-058)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;

  beforeAll(async () => {
    ({ server, signUp, close: closeAll } = await startE2eApp('rp'));
  });
  afterAll(() => closeAll());

  async function rows(sql: string, params: unknown[] = []) {
    const pool = createPool(process.env.TEST_DATABASE_URL!, 1);
    try {
      return (await pool.query(sql, params)).rows as Array<Record<string, unknown>>;
    } finally {
      await pool.end();
    }
  }

  async function setUp() {
    const [anna, ben] = [await signUp(), await signUp()];
    const conv = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: ben.id })
      .expect(201);
    const conversationId = conv.body.id as string;
    const msg = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), body: 'rude text' })
      .expect(201);
    return { anna, ben, conversationId, messageId: msg.body.id as string };
  }

  const report = (user: E2eUser, conversationId: string, messageId: string, body: object) =>
    request(server())
      .post(`/conversations/${conversationId}/messages/${messageId}/report`)
      .set(bearer(user.token))
      .send(body);

  it('stores the report with a copy of the text, once per reporter and message', async () => {
    const { anna, ben, conversationId, messageId } = await setUp();
    await report(ben, conversationId, messageId, {
      reason: 'harassment',
      details: ' mean ',
    }).expect(204);
    await report(ben, conversationId, messageId, { reason: 'spam' }).expect(204);
    const stored = await rows('SELECT * FROM message_reports WHERE message_id = $1', [messageId]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      reporter_id: ben.id,
      reported_user_id: anna.id,
      reason: 'spam',
      body_snapshot: 'rude text',
    });
  });

  it('keeps the report after the sender deletes the message', async () => {
    const { anna, ben, conversationId, messageId } = await setUp();
    await report(ben, conversationId, messageId, { reason: 'inappropriate' }).expect(204);
    await request(server())
      .delete(`/conversations/${conversationId}/messages/${messageId}`)
      .set(bearer(anna.token))
      .expect(200);
    const stored = await rows('SELECT body_snapshot FROM message_reports WHERE reporter_id = $1', [
      ben.id,
    ]);
    expect(stored).toHaveLength(1);
  });

  it('refuses your own message, bad reasons, outsiders and unknown messages', async () => {
    const { anna, conversationId, messageId } = await setUp();
    const outsider = await signUp();
    await report(anna, conversationId, messageId, { reason: 'spam' }).expect(400);
    await report(outsider, conversationId, messageId, { reason: 'spam' }).expect(404);
    const { ben, conversationId: c2, messageId: m2 } = await setUp();
    await report(ben, c2, m2, { reason: 'because' }).expect(400);
    await report(ben, c2, m2, { reason: 'spam', details: 'x'.repeat(501) }).expect(400);
    await report(ben, c2, '01ARZ3NDEKTSV4RRFFQ69G5FAV', { reason: 'spam' }).expect(404);
    // The wrong conversation for a real message.
    await report(ben, conversationId, m2, { reason: 'spam' }).expect(404);
    await request(server())
      .post(`/conversations/${c2}/messages/${m2}/report`)
      .send({ reason: 'spam' })
      .expect(401);
  });
});

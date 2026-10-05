import type { INestApplication } from '@nestjs/common';
import { LIMITS } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bearer, startE2eApp, type E2eUser, type TestSocket } from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('reactions (CHAT-033)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll } = await startE2eApp('rx'));
  });
  afterAll(() => closeAll());

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
      .send({ clientMsgId: randomUUID(), body: 'hello' })
      .expect(201);
    return { anna, ben, conversationId, messageId: msg.body.id as string };
  }

  const react = (user: E2eUser, conversationId: string, messageId: string, emoji: string) =>
    request(server())
      .post(`/conversations/${conversationId}/messages/${messageId}/reactions`)
      .set(bearer(user.token))
      .send({ emoji });

  it('toggles, groups by emoji, reaches everyone live and shows in history', async () => {
    const { anna, ben, conversationId, messageId } = await setUp();
    const annaSocket = await connect(anna);

    await react(ben, conversationId, messageId, '👍').expect(200);
    const both = await react(anna, conversationId, messageId, '👍').expect(200);
    expect(both.body.reactions).toEqual([{ emoji: '👍', count: 2, userIds: [ben.id, anna.id] }]);
    await annaSocket.waitFor(
      'message.reactions',
      (p) => p.messageId === messageId && (p.reactions as unknown[]).length === 1,
    );

    // Toggling again removes only my own.
    const after = await react(anna, conversationId, messageId, '👍').expect(200);
    expect(after.body.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [ben.id] }]);

    const history = await request(server())
      .get(`/conversations/${conversationId}/messages`)
      .set(bearer(anna.token))
      .expect(200);
    expect(history.body.messages.at(-1).reactions).toEqual([
      { emoji: '👍', count: 1, userIds: [ben.id] },
    ]);
  });

  it('refuses non-emoji, outsiders, deleted messages and too many distinct emoji', async () => {
    const { anna, conversationId, messageId } = await setUp();
    const outsider = await signUp();
    await react(anna, conversationId, messageId, 'lol').expect(400);
    await react(anna, conversationId, messageId, '<b>').expect(400);
    await react(outsider, conversationId, messageId, '👍').expect(404);

    const many = [
      '😀',
      '😁',
      '😂',
      '🤣',
      '😃',
      '😄',
      '😅',
      '😆',
      '😉',
      '😊',
      '😋',
      '😎',
      '😍',
      '😘',
      '🥰',
      '😗',
      '😙',
      '🥲',
      '😚',
      '🙂',
    ];
    expect(many).toHaveLength(LIMITS.reactionsPerMessageMax);
    for (const e of many) await react(anna, conversationId, messageId, e).expect(200);
    await react(anna, conversationId, messageId, '🤗').expect(400);

    await request(server())
      .delete(`/conversations/${conversationId}/messages/${messageId}`)
      .set(bearer(anna.token))
      .expect(200);
    await react(anna, conversationId, messageId, '👍').expect(400);
  });

  it('stops reactions both ways in a direct conversation once either side blocks', async () => {
    const { anna, ben, conversationId, messageId } = await setUp();
    const annaSocket = await connect(anna);
    await request(server()).post(`/users/${ben.id}/block`).set(bearer(anna.token)).expect(200);

    await react(ben, conversationId, messageId, '👍').expect(403);
    await react(anna, conversationId, messageId, '👍').expect(403);
    await annaSocket.expectNone('message.reactions', (p) => p.messageId === messageId, 300);

    await request(server()).delete(`/users/${ben.id}/block`).set(bearer(anna.token)).expect(200);
    await react(ben, conversationId, messageId, '👍').expect(200);
  });

  it('keeps the distinct-emoji cap under concurrent new emoji', async () => {
    const { anna, conversationId, messageId } = await setUp();
    // Code points from a contiguous emoji block, one more than the cap, all at once.
    const emoji = Array.from({ length: LIMITS.reactionsPerMessageMax + 5 }, (_, i) =>
      String.fromCodePoint(0x1f600 + i),
    );
    const results = await Promise.all(emoji.map((e) => react(anna, conversationId, messageId, e)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(LIMITS.reactionsPerMessageMax);
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
  });
});

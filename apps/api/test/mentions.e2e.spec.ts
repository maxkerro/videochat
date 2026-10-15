import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bearer,
  startE2eApp,
  type E2eUser,
  type FakePushChannel,
  type FakeS3Service,
} from './e2e-app.js';
import { hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('@mentions (CHAT-073)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  let push: FakePushChannel;
  let s3: FakeS3Service;

  beforeAll(async () => {
    ({ server, signUp, close: closeAll, push, s3 } = await startE2eApp('mn'));
  });
  afterAll(() => closeAll());

  const usernameOf = (u: E2eUser) => u.session.user.username;

  async function subscribe(user: E2eUser): Promise<string> {
    const endpoint = `https://push.example/${randomUUID()}`;
    await request(server())
      .post('/push/subscriptions')
      .set(bearer(user.token))
      .send({ endpoint, keys: { p256dh: 'BAbc', auth: 'xyz' } })
      .expect(204);
    return endpoint;
  }

  async function setUp() {
    const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
    const group = await request(server())
      .post('/conversations/group')
      .set(bearer(anna.token))
      .send({ title: 'Team', memberIds: [ben.id, clara.id] })
      .expect(201);
    return { anna, ben, clara, groupId: group.body.id as string };
  }

  const send = (user: E2eUser, conversationId: string, body: string) =>
    request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(user.token))
      .send({ clientMsgId: randomUUID(), body })
      .expect(201);

  const mute = (user: E2eUser, conversationId: string) =>
    request(server())
      .put(`/conversations/${conversationId}/mute`)
      .set(bearer(user.token))
      .send({ muted: true })
      .expect(200);

  const sentTo = (endpoint: string) => push.sent.filter((s) => s.endpoint === endpoint);
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it('stores the ids of mentioned members only (not yourself, outsiders or unknown names)', async () => {
    const { anna, ben, clara, groupId } = await setUp();
    const outsider = await signUp();
    const res = await send(
      anna,
      groupId,
      `@${usernameOf(ben)} and @${usernameOf(clara).toUpperCase()}, cc @${usernameOf(anna)} @${usernameOf(outsider)} @nobody_here mail@${usernameOf(ben)}`,
    );
    expect(new Set(res.body.mentions)).toEqual(new Set([ben.id, clara.id]));

    const plain = await send(anna, groupId, 'nobody mentioned');
    expect(plain.body.mentions).toBeUndefined();

    const history = await request(server())
      .get(`/conversations/${groupId}/messages`)
      .set(bearer(ben.token))
      .expect(200);
    expect(
      history.body.messages.find((m: { id: string }) => m.id === res.body.id).mentions,
    ).toHaveLength(2);
  });

  it('has no mentions in a direct chat', async () => {
    const [anna, ben] = [await signUp(), await signUp()];
    const direct = await request(server())
      .post('/conversations/direct')
      .set(bearer(anna.token))
      .send({ userId: ben.id })
      .expect(201);
    const res = await send(anna, direct.body.id, `hey @${usernameOf(ben)}`);
    expect(res.body.mentions).toBeUndefined();
  });

  it('re-resolves mentions when the text is edited', async () => {
    const { anna, ben, clara, groupId } = await setUp();
    const sent = await send(anna, groupId, `@${usernameOf(ben)} hi`);
    const edited = await request(server())
      .patch(`/conversations/${groupId}/messages/${sent.body.id}`)
      .set(bearer(anna.token))
      .send({ body: `@${usernameOf(clara)} hi` })
      .expect(200);
    expect(edited.body.mentions).toEqual([clara.id]);
    const cleared = await request(server())
      .patch(`/conversations/${groupId}/messages/${sent.body.id}`)
      .set(bearer(anna.token))
      .send({ body: 'hi all' })
      .expect(200);
    expect(cleared.body.mentions).toBeUndefined();
  });

  it('counts unread mentions in the inbox until they are read', async () => {
    const { anna, ben, groupId } = await setUp();
    await send(anna, groupId, `@${usernameOf(ben)} one`);
    await send(anna, groupId, 'no mention');
    const last = await send(anna, groupId, `two @${usernameOf(ben)}`);
    const unreadFor = async (user: E2eUser) => {
      const list = await request(server()).get('/conversations').set(bearer(user.token));
      return list.body.find((c: { id: string }) => c.id === groupId).unreadMentions as number;
    };
    expect(await unreadFor(ben)).toBe(2);
    expect(await unreadFor(anna)).toBe(0);
    const one = await request(server())
      .get(`/conversations/${groupId}`)
      .set(bearer(ben.token))
      .expect(200);
    expect(one.body.unreadMentions).toBe(2);

    await request(server())
      .post(`/conversations/${groupId}/read`)
      .set(bearer(ben.token))
      .send({ seq: last.body.seq })
      .expect((r) => expect(r.status).toBeLessThan(300));
    expect(await unreadFor(ben)).toBe(0);
  });

  it('notifies a mentioned member with "mentioned you", even in a muted group, unless turned off', async () => {
    const { anna, ben, clara, groupId } = await setUp();
    const benPush = await subscribe(ben);
    const claraPush = await subscribe(clara);

    await send(anna, groupId, `@${usernameOf(ben)} look`);
    await settle();
    expect(sentTo(benPush).map((s) => s.payload.title)).toEqual([
      `${anna.session.user.displayName} mentioned you · Team`,
    ]);
    expect(sentTo(claraPush).map((s) => s.payload.title)).toEqual([
      `${anna.session.user.displayName} · Team`,
    ]);

    await mute(ben, groupId);
    await mute(clara, groupId);
    await send(anna, groupId, `@${usernameOf(ben)} @${usernameOf(clara)} muted but mentioned`);
    await send(anna, groupId, 'muted, no mention');
    await settle();
    expect(sentTo(benPush)).toHaveLength(2);
    expect(sentTo(claraPush)).toHaveLength(2);

    await request(server())
      .patch('/me/settings')
      .set(bearer(ben.token))
      .send({ notifications: { mentions: false } })
      .expect(200);
    await send(anna, groupId, `@${usernameOf(ben)} again`);
    await settle();
    expect(sentTo(benPush)).toHaveLength(2);
  });
  it('keeps the attachment when a captioned file is edited to mention someone', async () => {
    const { anna, ben, groupId } = await setUp();
    const upload = await request(server())
      .post(`/conversations/${groupId}/attachments`)
      .set(bearer(anna.token))
      .send({ filename: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 5 })
      .expect(201);
    s3.upload(upload.body.uploadUrl, Buffer.from('%PDF-'), 'application/pdf');
    const sent = await request(server())
      .post(`/conversations/${groupId}/messages`)
      .set(bearer(anna.token))
      .send({ clientMsgId: randomUUID(), attachmentId: upload.body.attachmentId, body: 'plan' })
      .expect(201);
    const edited = await request(server())
      .patch(`/conversations/${groupId}/messages/${sent.body.id}`)
      .set(bearer(anna.token))
      .send({ body: `plan for @${usernameOf(ben)}` })
      .expect(200);
    expect(edited.body.mentions).toEqual([ben.id]);
    expect(edited.body.attachment).toMatchObject({ filename: 'plan.pdf' });
    const cleared = await request(server())
      .patch(`/conversations/${groupId}/messages/${sent.body.id}`)
      .set(bearer(anna.token))
      .send({ body: 'plan' })
      .expect(200);
    expect(cleared.body.mentions).toBeUndefined();
    expect(cleared.body.attachment).toMatchObject({ filename: 'plan.pdf' });
  });

  it('ignores mentions of someone who left, and stops counting them after they leave', async () => {
    const { anna, ben, clara, groupId } = await setUp();
    const claraPush = await subscribe(clara);
    await send(anna, groupId, `@${usernameOf(clara)} before`);
    await request(server())
      .post(`/conversations/${groupId}/leave`)
      .set(bearer(clara.token))
      .expect((r) => expect(r.status).toBeLessThan(300));
    await settle();
    const before = sentTo(claraPush).length;

    const after = await send(anna, groupId, `@${usernameOf(clara)} @${usernameOf(ben)} after`);
    expect(after.body.mentions).toEqual([ben.id]);
    await settle();
    expect(sentTo(claraPush)).toHaveLength(before);
    const list = await request(server()).get('/conversations').set(bearer(clara.token));
    expect(list.body.find((c: { id: string }) => c.id === groupId)).toBeUndefined();
  });

  it('a muted mention respects "notifications off" and blocks', async () => {
    const { anna, ben, clara, groupId } = await setUp();
    const benPush = await subscribe(ben);
    const claraPush = await subscribe(clara);
    await mute(ben, groupId);
    await mute(clara, groupId);
    // Ben turned notifications off altogether; Clara blocked Anna.
    await request(server())
      .patch('/me/settings')
      .set(bearer(ben.token))
      .send({ notifications: { enabled: false } })
      .expect(200);
    await request(server())
      .post(`/users/${anna.id}/block`)
      .set(bearer(clara.token))
      .expect((r) => expect(r.status).toBeLessThan(300));

    await send(anna, groupId, `@${usernameOf(ben)} @${usernameOf(clara)} hello`);
    await settle();
    expect(sentTo(benPush)).toHaveLength(0);
    expect(sentTo(claraPush)).toHaveLength(0);
  });
});

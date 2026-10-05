import type { INestApplication } from '@nestjs/common';
import { authSessionSchema } from '@videochat/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bearer,
  startE2eApp,
  type E2eUser,
  type FakeS3Service,
  type TestSocket,
} from './e2e-app.js';
import { hasInfra } from './helpers.js';

const PASSWORD = 'correct-horse-battery-staple';

describe.skipIf(!hasInfra)('settings and account (CHAT-037)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let connect: (user: E2eUser) => Promise<TestSocket>;
  let closeAll: () => Promise<void>;
  let s3: FakeS3Service;

  beforeAll(async () => {
    ({ server, signUp, connect, close: closeAll, s3 } = await startE2eApp('acct'));
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
    const bodies = history.body.messages.map((m: { body: string | null }) => m.body);
    expect(bodies).not.toContain('my secret');
    expect(bodies.at(-1)).toBe('A member deleted their account');
    const found = await request(server())
      .get('/users/search')
      .query({ q: email })
      .set(bearer(ben.token))
      .expect(200);
    expect(found.body.users).toHaveLength(0);
  });

  describe('review follow-ups', () => {
    it("closes the deleted user's open sockets, so a still-open tab hears nothing more", async () => {
      const [anna, ben] = [await signUp(), await signUp()];
      const conversationId = await direct(anna, ben);
      const annaTab = await connect(anna);
      const closed = new Promise<number>((resolve) =>
        annaTab.ws.once('close', (code) => resolve(code)),
      );
      await request(server())
        .post('/auth/delete-account')
        .set(bearer(anna.token))
        .send({ password: PASSWORD })
        .expect(204);
      expect(await closed).toBe(4401);
      await request(server())
        .post(`/conversations/${conversationId}/messages`)
        .set(bearer(ben.token))
        .send({ clientMsgId: randomUUID(), body: 'are you there?' })
        .expect(201);
      await annaTab.expectNone('message.new', (p) => p.body === 'are you there?', 400);
    });

    it("refuses the deleted account's still-unexpired access token, and messaging it", async () => {
      const [anna, ben] = [await signUp(), await signUp()];
      await request(server())
        .post('/auth/delete-account')
        .set(bearer(anna.token))
        .send({ password: PASSWORD })
        .expect(204);
      await request(server()).get('/me').set(bearer(anna.token)).expect(401);
      await request(server())
        .patch('/me')
        .set(bearer(anna.token))
        .send({ displayName: 'Back' })
        .expect(401);
      await request(server())
        .post('/conversations/direct')
        .set(bearer(ben.token))
        .send({ userId: anna.id })
        .expect(404);
    });

    it("can't be blocked by someone squatting the deleted username", async () => {
      const victim = await signUp();
      const squat = `deleted_${victim.id.replace(/-/g, '').slice(0, 22)}`;
      await request(server())
        .post('/auth/signup')
        .send({
          email: `sq-${randomUUID()}@test.dev`,
          username: squat,
          displayName: 'x',
          password: PASSWORD,
        })
        .expect(400);
      await request(server())
        .patch('/me')
        .set(bearer(victim.token))
        .send({ username: 'deleted_abc' })
        .expect(400);
      await request(server())
        .post('/auth/delete-account')
        .set(bearer(victim.token))
        .send({ password: PASSWORD })
        .expect(204);
    });

    it("hands a group's admin role on, keeps call history, and removes the files", async () => {
      const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
      const group = await request(server())
        .post('/conversations/group')
        .set(bearer(anna.token))
        .send({ title: 'Team', memberIds: [ben.id, clara.id] })
        .expect(201);
      const conversationId = group.body.id as string;
      const upload = await request(server())
        .post(`/conversations/${conversationId}/attachments`)
        .set(bearer(anna.token))
        .send({ filename: 'notes.txt', contentType: 'text/plain', sizeBytes: 5 })
        .expect(201);
      s3.upload(upload.body.uploadUrl, Buffer.from('notes'), 'text/plain');
      await request(server())
        .post(`/conversations/${conversationId}/messages`)
        .set(bearer(anna.token))
        .send({ clientMsgId: randomUUID(), attachmentId: upload.body.attachmentId })
        .expect(201);
      const key = s3.keyFromUrl(upload.body.uploadUrl);
      expect(s3.objects.has(key)).toBe(true);

      await request(server())
        .post('/auth/delete-account')
        .set(bearer(anna.token))
        .send({ password: PASSWORD })
        .expect(204);

      expect(s3.objects.has(key)).toBe(false);
      const members = await request(server())
        .get(`/conversations/${conversationId}/members`)
        .set(bearer(ben.token))
        .expect(200);
      expect(members.body.map((m: { userId: string }) => m.userId).sort()).toEqual(
        [ben.id, clara.id].sort(),
      );
      expect(members.body.some((m: { role: string }) => m.role === 'admin')).toBe(true);
      const history = await request(server())
        .get(`/conversations/${conversationId}/messages`)
        .set(bearer(ben.token))
        .expect(200);
      expect(history.body.messages.map((m: { body: string | null }) => m.body)).toEqual(
        expect.arrayContaining([
          'A member deleted their account',
          expect.stringMatching(/is now an admin$/),
        ]),
      );
    });

    it('a password change refuses old access tokens and closes other connections', async () => {
      const anna = await signUp();
      const otherDevice = await connect(anna);
      const closed = new Promise<number>((resolve) =>
        otherDevice.ws.once('close', (code) => resolve(code)),
      );
      // Old tokens issued in the same second as the change are still accepted; step past it.
      await new Promise((r) => setTimeout(r, 1100));
      // No refresh cookie at all: every session's refresh token ends, nothing is kept.
      await request(server())
        .post('/auth/change-password')
        .set(bearer(anna.token))
        .send({ currentPassword: PASSWORD, newPassword: 'another-long-password' })
        .expect(204);
      expect(await closed).toBe(4401);
      await request(server()).get('/me').set(bearer(anna.token)).expect(401);
    });

    it("members list: with your own receipts off you see nobody's reads; theirs off hides theirs", async () => {
      const [anna, ben, clara] = [await signUp(), await signUp(), await signUp()];
      const group = await request(server())
        .post('/conversations/group')
        .set(bearer(anna.token))
        .send({ title: 'G', memberIds: [ben.id, clara.id] })
        .expect(201);
      const conversationId = group.body.id as string;
      const sent = await request(server())
        .post(`/conversations/${conversationId}/messages`)
        .set(bearer(anna.token))
        .send({ clientMsgId: randomUUID(), body: 'hi' })
        .expect(201);
      for (const u of [ben, clara]) {
        await request(server())
          .post(`/conversations/${conversationId}/read`)
          .set(bearer(u.token))
          .send({ seq: sent.body.seq })
          .expect(201);
      }
      await request(server())
        .patch('/me/settings')
        .set(bearer(clara.token))
        .send({ readReceipts: false })
        .expect(200);
      const seenBy = async (viewer: E2eUser) =>
        Object.fromEntries(
          (
            await request(server())
              .get(`/conversations/${conversationId}/members`)
              .set(bearer(viewer.token))
              .expect(200)
          ).body.map((m: { userId: string; lastReadSeq: number }) => [m.userId, m.lastReadSeq]),
        );
      const forAnna = await seenBy(anna);
      expect(forAnna[ben.id]).toBe(sent.body.seq);
      expect(forAnna[clara.id]).toBe(0);
      const forClara = await seenBy(clara);
      expect(forClara[ben.id]).toBe(0);
      expect(forClara[clara.id]).toBe(sent.body.seq);
    });
  });
});

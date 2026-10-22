import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { MailService } from '../src/mail/mail.service.js';
import { bearer, startE2eApp, type E2eUser, type FakeMailService } from './e2e-app.js';
import { hasInfra } from './helpers.js';

/** CHAT-077: reports, the moderation queue, actions and the audit log. */
describe.skipIf(!hasInfra)('moderation (CHAT-077)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  let mail: FakeMailService;
  let db: pg.Client;

  beforeAll(async () => {
    const app = await startE2eApp('md', { E2EE_PROTOTYPE: true });
    ({ server, signUp, close: closeAll } = app);
    mail = app.moduleRef.get(MailService) as unknown as FakeMailService;
    db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => {
    await db.end();
    await closeAll();
  });

  const password = 'correct-horse-battery-staple';
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  async function moderator(): Promise<E2eUser> {
    const mod = await signUp();
    await db.query('UPDATE users SET is_moderator = true WHERE id = $1', [mod.id]);
    return mod;
  }

  async function dm(a: E2eUser, b: E2eUser): Promise<string> {
    const res = await request(server())
      .post('/conversations/direct')
      .set(bearer(a.token))
      .send({ userId: b.id })
      .expect((r) => expect([200, 201]).toContain(r.status));
    return res.body.id as string;
  }

  const send = async (user: E2eUser, conversationId: string, body: string) =>
    (
      await request(server())
        .post(`/conversations/${conversationId}/messages`)
        .set(bearer(user.token))
        .send({ clientMsgId: randomUUID(), body })
        .expect(201)
    ).body as { id: string; seq: number };

  it('is for moderators only', async () => {
    const user = await signUp();
    await request(server()).get('/moderation/reports').set(bearer(user.token)).expect(403);
    await request(server()).get('/moderation/audit').set(bearer(user.token)).expect(403);
    await request(server()).get('/moderation/reports').expect(401);
    const me = await request(server()).get('/me').set(bearer(user.token)).expect(200);
    expect(me.body.moderator).toBe(false);
    const mod = await moderator();
    const modMe = await request(server()).get('/me').set(bearer(mod.token)).expect(200);
    expect(modMe.body.moderator).toBe(true);
  });

  it('puts a report in the queue at once, and shows only 5 messages around it (audited)', async () => {
    const [anna, ben, mod] = [await signUp(), await signUp(), await moderator()];
    const conversationId = await dm(anna, ben);
    const sent: { id: string; seq: number }[] = [];
    for (let i = 1; i <= 12; i++)
      sent.push(await send(i % 2 ? ben : anna, conversationId, `m${i}`));
    const reported = sent[6]!; // "m7", from Ben
    await request(server())
      .post(`/conversations/${conversationId}/messages/${reported.id}/report`)
      .set(bearer(anna.token))
      .send({ reason: 'harassment', details: 'keeps doing this' })
      .expect(204);

    const queue = await request(server())
      .get('/moderation/reports')
      .set(bearer(mod.token))
      .expect(200);
    const item = queue.body.reports.find((r: { messageId: string }) => r.messageId === reported.id);
    expect(item).toMatchObject({
      kind: 'message',
      status: 'open',
      reason: 'harassment',
      details: 'keeps doing this',
      reporter: { id: anna.id },
      reportedUser: { id: ben.id },
      openReportsAboutUser: 1,
    });

    const detail = await request(server())
      .get(`/moderation/reports/${item.id}`)
      .set(bearer(mod.token))
      .expect(200);
    expect(detail.body.snapshot).toEqual({ text: 'm7', fromReporter: false });
    const texts = detail.body.context.map((m: { text: string }) => m.text);
    expect(texts).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(detail.body.context.filter((m: { reported: boolean }) => m.reported)).toHaveLength(1);

    const audit = await request(server())
      .get(`/moderation/audit?userId=${ben.id}`)
      .set(bearer(mod.token))
      .expect(200);
    expect(audit.body.entries[0]).toMatchObject({
      action: 'view_report',
      moderator: { id: mod.id },
      reportId: item.id,
    });
  });

  it('takes reports of a person, from a chat you share', async () => {
    const [anna, ben, outsider, mod] = [
      await signUp(),
      await signUp(),
      await signUp(),
      await moderator(),
    ];
    const conversationId = await dm(anna, ben);
    await request(server())
      .post(`/users/${ben.id}/report`)
      .set(bearer(outsider.token))
      .send({ conversationId, reason: 'spam' })
      .expect(404);
    await request(server())
      .post(`/users/${anna.id}/report`)
      .set(bearer(anna.token))
      .send({ conversationId, reason: 'spam' })
      .expect(400);
    for (let i = 0; i < 2; i++) {
      await request(server())
        .post(`/users/${ben.id}/report`)
        .set(bearer(anna.token))
        .send({ conversationId, reason: 'spam', details: 'fake giveaway links' })
        .expect(204);
    }
    const queue = await request(server())
      .get('/moderation/reports')
      .set(bearer(mod.token))
      .expect(200);
    const mine = queue.body.reports.filter(
      (r: { kind: string; reportedUser: { id: string } | null }) =>
        r.kind === 'user' && r.reportedUser?.id === ben.id,
    );
    expect(mine).toHaveLength(1); // reporting again while open updates the same report
    const detail = await request(server())
      .get(`/moderation/reports/${mine[0].id}`)
      .set(bearer(mod.token))
      .expect(200);
    expect(detail.body).toMatchObject({ snapshot: null, context: [] });
  });

  it('warns, suspends (ending every session), lifts and bans -- each logged', async () => {
    const [anna, ben, mod] = [await signUp(), await signUp(), await moderator()];
    const conversationId = await dm(anna, ben);
    const report = async () => {
      const m = await send(ben, conversationId, `bad ${randomUUID()}`);
      await request(server())
        .post(`/conversations/${conversationId}/messages/${m.id}/report`)
        .set(bearer(anna.token))
        .send({ reason: 'inappropriate' })
        .expect(204);
      const queue = await request(server()).get('/moderation/reports').set(bearer(mod.token));
      return queue.body.reports.find((r: { messageId: string }) => r.messageId === m.id)
        .id as string;
    };

    // Warn: the report closes, Ben gets an email, nothing else changes.
    const first = await report();
    const warned = await request(server())
      .post(`/moderation/reports/${first}/resolve`)
      .set(bearer(mod.token))
      .send({ action: 'warn', note: 'first offence' })
      .expect(200);
    expect(warned.body).toMatchObject({
      status: 'resolved',
      resolution: { action: 'warn', note: 'first offence', by: { id: mod.id } },
    });
    await request(server())
      .post(`/moderation/reports/${first}/resolve`)
      .set(bearer(mod.token))
      .send({ action: 'dismiss' })
      .expect(409);
    expect(mail.notices.filter((n) => n.kind === 'warn')).toHaveLength(1);
    await request(server()).get('/me').set(bearer(ben.token)).expect(200);

    // Suspend: needs days; Ben's access token, refresh token and sign-in all stop working.
    const second = await report();
    await request(server())
      .post(`/moderation/reports/${second}/resolve`)
      .set(bearer(mod.token))
      .send({ action: 'suspend' })
      .expect(400);
    await request(server())
      .post(`/moderation/reports/${second}/resolve`)
      .set(bearer(mod.token))
      .send({ action: 'suspend', days: 7 })
      .expect(200);
    await request(server()).get('/me').set(bearer(ben.token)).expect(401);
    const login = await request(server())
      .post('/auth/login')
      .send({ identifier: await usernameOfDirect(ben.id), password })
      .expect(403);
    expect(login.body.message).toMatch(/suspended until/);

    // Lift: Ben can sign in again.
    await request(server())
      .post(`/moderation/users/${ben.id}/lift`)
      .set(bearer(mod.token))
      .send({ note: 'appeal accepted' })
      .expect(204);
    const back = await request(server())
      .post('/auth/login')
      .send({ identifier: await usernameOfDirect(ben.id), password })
      .expect(200);

    // Ban.
    const third = await report();
    await request(server())
      .post(`/moderation/reports/${third}/resolve`)
      .set(bearer(mod.token))
      .send({ action: 'ban' })
      .expect(200);
    await request(server()).get('/me').set(bearer(back.body.accessToken)).expect(401);
    const banned = await request(server())
      .post('/auth/login')
      .send({ identifier: await usernameOfDirect(ben.id), password })
      .expect(403);
    expect(banned.body.message).toMatch(/banned/);

    const audit = await request(server())
      .get(`/moderation/audit?userId=${ben.id}`)
      .set(bearer(mod.token))
      .expect(200);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a !== 'view_report')).toEqual([
      'ban',
      'lift',
      'suspend',
      'warn',
    ]);
    expect(
      audit.body.entries.find((e: { action: string }) => e.action === 'suspend').details,
    ).toMatchObject({ days: 7 });
    expect(mail.notices.map((n) => n.kind)).toEqual(expect.arrayContaining(['suspend', 'ban']));
  });

  it('won’t let a moderator act on a report about themselves', async () => {
    const [anna, mod] = [await signUp(), await moderator()];
    const conversationId = await dm(anna, mod);
    const m = await send(mod, conversationId, 'hello');
    await request(server())
      .post(`/conversations/${conversationId}/messages/${m.id}/report`)
      .set(bearer(anna.token))
      .send({ reason: 'spam' })
      .expect(204);
    const queue = await request(server()).get('/moderation/reports').set(bearer(mod.token));
    const id = queue.body.reports.find((r: { messageId: string }) => r.messageId === m.id).id;
    await request(server())
      .post(`/moderation/reports/${id}/resolve`)
      .set(bearer(mod.token))
      .send({ action: 'ban' })
      .expect(400);
  });

  it('keeps the reporter’s decrypted text for an encrypted message, marked unverified', async () => {
    const [anna, ben, mod] = [await signUp(), await signUp(), await moderator()];
    const register = async (u: E2eUser) => {
      const d = (await request(server()).post('/e2ee/devices').set(bearer(u.token)).send({})).body
        .deviceId as string;
      await request(server())
        .post(`/e2ee/devices/${d}/key-packages`)
        .set(bearer(u.token))
        .send({ keyPackages: [b64('kp')] });
      return d;
    };
    const [annaDevice, benDevice] = [await register(anna), await register(ben)];
    const conversationId = await dm(anna, ben);
    await request(server())
      .post(`/e2ee/conversations/${conversationId}/group`)
      .set(bearer(ben.token))
      .send({ deviceId: benDevice, welcomes: [{ deviceId: annaDevice, welcome: b64('w') }] })
      .expect(201);
    const sent = await request(server())
      .post(`/conversations/${conversationId}/messages`)
      .set(bearer(ben.token))
      .send({ clientMsgId: randomUUID(), e2ee: { v: 1, ciphertext: b64('ct') } })
      .expect(201);
    await request(server())
      .post(`/conversations/${conversationId}/messages/${sent.body.id}/report`)
      .set(bearer(anna.token))
      .send({ reason: 'harassment', decryptedText: 'what the message said' })
      .expect(204);
    const queue = await request(server()).get('/moderation/reports').set(bearer(mod.token));
    const id = queue.body.reports.find(
      (r: { messageId: string }) => r.messageId === sent.body.id,
    ).id;
    const detail = await request(server()).get(`/moderation/reports/${id}`).set(bearer(mod.token));
    expect(detail.body.snapshot).toEqual({ text: 'what the message said', fromReporter: true });
    expect(detail.body.context.find((m: { reported: boolean }) => m.reported)).toMatchObject({
      encrypted: true,
      text: null,
    });
  });

  async function usernameOfDirect(id: string): Promise<string> {
    const { rows } = await db.query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [id],
    );
    return rows[0]!.username;
  }
});

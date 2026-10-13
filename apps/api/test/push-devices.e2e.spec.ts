import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createPool } from '../src/db/client.js';
import { bearer, startE2eApp, type E2eUser } from './e2e-app.js';
import { hasInfra } from './helpers.js';

/** CHAT-055: a phone's push token belongs to one login session, and only its owner can touch it. */
describe.skipIf(!hasInfra)('native push devices (CHAT-055)', () => {
  let server: () => ReturnType<INestApplication['getHttpServer']>;
  let signUp: () => Promise<E2eUser>;
  let closeAll: () => Promise<void>;
  const pool = () => createPool(process.env.TEST_DATABASE_URL!, 1);

  beforeAll(async () => {
    ({ server, signUp, close: closeAll } = await startE2eApp('pd'));
  });
  afterAll(() => closeAll());

  /** Signs `user` in again the way the phone does, so it gets a refresh token of its own. */
  async function phoneSession(user: E2eUser, password = 'correct-horse-battery-staple') {
    const email = (await rows('SELECT email FROM users WHERE id = $1', [user.id]))[0]!
      .email as string;
    const res = await request(server())
      .post('/auth/login')
      .set('X-Refresh-Mode', 'body')
      .send({ email, password })
      .expect(200);
    return {
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
    };
  }

  async function rows(sql: string, params: unknown[] = []) {
    const p = pool();
    try {
      return (await p.query(sql, params)).rows as Array<Record<string, unknown>>;
    } finally {
      await p.end();
    }
  }
  const tokensOf = async (userId: string) =>
    (
      await rows('SELECT push_token FROM devices WHERE user_id = $1 ORDER BY push_token', [userId])
    ).map((r) => r.push_token as string);

  const register = (accessToken: string, body: Record<string, unknown>) =>
    request(server()).post('/push/devices').set(bearer(accessToken)).send(body);

  const fcm = () => `fcm-${randomUUID()}`;

  it('registers a token for the signed-in session', async () => {
    const user = await signUp();
    const phone = await phoneSession(user);
    const token = fcm();
    await register(phone.accessToken, {
      platform: 'android',
      token,
      refreshToken: phone.refreshToken,
    }).expect(204);
    const [row] = await rows(
      'SELECT user_id, platform, session_family_id FROM devices WHERE push_token = $1',
      [token],
    );
    expect(row).toMatchObject({ user_id: user.id, platform: 'android' });
    expect(row!.session_family_id).toBeTruthy();
  });

  it('rejects empty, oversized or incomplete bodies', async () => {
    const user = await signUp();
    const phone = await phoneSession(user);
    const ok = { platform: 'android', token: fcm(), refreshToken: phone.refreshToken };
    await register(phone.accessToken, { ...ok, token: '' }).expect(400);
    await register(phone.accessToken, { ...ok, token: 'x'.repeat(4097) }).expect(400);
    await register(phone.accessToken, { ...ok, platform: 'web' }).expect(400);
    await register(phone.accessToken, { platform: 'android', token: fcm() }).expect(400);
    await request(server()).post('/push/devices').send(ok).expect(401);
  });

  it("refuses a refresh token that isn't the caller's, or isn't valid", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const [phoneA, phoneB] = [await phoneSession(a), await phoneSession(b)];
    await register(phoneA.accessToken, {
      platform: 'android',
      token: fcm(),
      refreshToken: phoneB.refreshToken,
    }).expect(401);
    await register(phoneA.accessToken, {
      platform: 'android',
      token: fcm(),
      refreshToken: 'not-a-token',
    }).expect(401);
    expect(await tokensOf(a.id)).toEqual([]);
  });

  it('moves a token to whoever registers it next (a phone changing hands)', async () => {
    const [a, b] = [await signUp(), await signUp()];
    const [phoneA, phoneB] = [await phoneSession(a), await phoneSession(b)];
    const token = fcm();
    await register(phoneA.accessToken, {
      platform: 'android',
      token,
      refreshToken: phoneA.refreshToken,
    }).expect(204);
    await register(phoneB.accessToken, {
      platform: 'android',
      token,
      refreshToken: phoneB.refreshToken,
    }).expect(204);
    expect(await tokensOf(a.id)).toEqual([]);
    expect(await tokensOf(b.id)).toEqual([token]);
  });

  it("only the owner can remove a token; someone else's delete changes nothing", async () => {
    const [a, b] = [await signUp(), await signUp()];
    const [phoneA, phoneB] = [await phoneSession(a), await phoneSession(b)];
    const token = fcm();
    await register(phoneA.accessToken, {
      platform: 'android',
      token,
      refreshToken: phoneA.refreshToken,
    }).expect(204);
    await request(server())
      .delete('/push/devices')
      .set(bearer(phoneB.accessToken))
      .send({ token })
      .expect(204);
    expect(await tokensOf(a.id)).toEqual([token]);
    await request(server())
      .delete('/push/devices')
      .set(bearer(phoneA.accessToken))
      .send({ token })
      .expect(204);
    expect(await tokensOf(a.id)).toEqual([]);
  });

  it('logging out removes that session’s tokens, and only that session’s', async () => {
    const user = await signUp();
    const [first, second] = [await phoneSession(user), await phoneSession(user)];
    const [t1, t2] = [fcm(), fcm()];
    await register(first.accessToken, {
      platform: 'android',
      token: t1,
      refreshToken: first.refreshToken,
    }).expect(204);
    await register(second.accessToken, {
      platform: 'android',
      token: t2,
      refreshToken: second.refreshToken,
    }).expect(204);
    await request(server())
      .post('/auth/logout')
      .set('X-Refresh-Mode', 'body')
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    expect(await tokensOf(user.id)).toEqual([t2]);
  });

  it('a session that has already ended cannot register', async () => {
    const user = await signUp();
    const phone = await phoneSession(user);
    await request(server())
      .post('/auth/logout')
      .set('X-Refresh-Mode', 'body')
      .send({ refreshToken: phone.refreshToken })
      .expect(200);
    await register(phone.accessToken, {
      platform: 'android',
      token: fcm(),
      refreshToken: phone.refreshToken,
    }).expect(401);
    expect(await tokensOf(user.id)).toEqual([]);
  });

  it('a reused (stolen) refresh token ends the session and its push tokens', async () => {
    const user = await signUp();
    const phone = await phoneSession(user);
    const token = fcm();
    await register(phone.accessToken, {
      platform: 'android',
      token,
      refreshToken: phone.refreshToken,
    }).expect(204);
    // The first refresh rotates the token; presenting the old one again is the reuse alarm.
    await request(server())
      .post('/auth/refresh')
      .set('X-Refresh-Mode', 'body')
      .send({ refreshToken: phone.refreshToken })
      .expect(200);
    await request(server())
      .post('/auth/refresh')
      .set('X-Refresh-Mode', 'body')
      .send({ refreshToken: phone.refreshToken })
      .expect(401);
    expect(await tokensOf(user.id)).toEqual([]);
  });

  it('changing the password keeps this phone’s token and removes the others’', async () => {
    const user = await signUp();
    const [mine, other] = [await phoneSession(user), await phoneSession(user)];
    const [t1, t2] = [fcm(), fcm()];
    await register(mine.accessToken, {
      platform: 'android',
      token: t1,
      refreshToken: mine.refreshToken,
    }).expect(204);
    await register(other.accessToken, {
      platform: 'android',
      token: t2,
      refreshToken: other.refreshToken,
    }).expect(204);
    await request(server())
      .post('/auth/change-password')
      .set(bearer(mine.accessToken))
      .set('X-Refresh-Mode', 'body')
      .send({
        currentPassword: 'correct-horse-battery-staple',
        newPassword: 'a-different-long-passphrase',
        refreshToken: mine.refreshToken,
      })
      .expect(204);
    expect(await tokensOf(user.id)).toEqual([t1]);
  });

  it('a session whose tokens have expired cannot register', async () => {
    const user = await signUp();
    const phone = await phoneSession(user);
    await rows(
      "UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
      [user.id],
    );
    await register(phone.accessToken, {
      platform: 'android',
      token: fcm(),
      refreshToken: phone.refreshToken,
    }).expect(401);
    expect(await tokensOf(user.id)).toEqual([]);
  });

  it('accepts a refresh token that was rotated after the phone read it (same live session)', async () => {
    // The phone reads its refresh token, then the request's own auth refresh rotates it
    // mid-flight. Registration must still succeed -- this leniency is load-bearing.
    const user = await signUp();
    const phone = await phoneSession(user);
    await request(server())
      .post('/auth/refresh')
      .set('X-Refresh-Mode', 'body')
      .send({ refreshToken: phone.refreshToken })
      .expect(200);
    const token = fcm();
    await register(phone.accessToken, {
      platform: 'android',
      token,
      refreshToken: phone.refreshToken,
    }).expect(204);
    expect(await tokensOf(user.id)).toEqual([token]);
  });
});

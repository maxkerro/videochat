import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import { listPushDevices, upsertNativePushDevice, upsertWebPushDevice } from '../src/db/devices.js';
import { createRefreshToken, revokeAllForUser, revokeFamily } from '../src/db/refresh-tokens.js';
import { users } from '../src/db/schema.js';
import { searchUsersByUsernamePrefix } from '../src/db/users.js';
import { freshDatabase, hasInfra } from './helpers.js';

const DAY = 86_400_000;

describe.skipIf(!hasInfra)('push devices and sessions (CHAT-055)', () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await freshDatabase());
  });
  afterAll(() => close());

  async function makeUser(username: string, displayName = username) {
    const [u] = await db
      .insert(users)
      .values({ username, email: `${username}@test.dev`, displayName })
      .returning();
    return u!;
  }
  async function session(userId: string, expiresInMs = DAY) {
    const familyId = randomUUID();
    await createRefreshToken(db, {
      userId,
      familyId,
      tokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      expiresAt: new Date(Date.now() + expiresInMs),
    });
    return familyId;
  }
  const tokensOf = async (userId: string) =>
    (await listPushDevices(db, [userId])).map((d) => d.token).sort();

  it('sends to a phone only while its session is live (expiry, revocation)', async () => {
    const u = await makeUser('pdint1');
    const live = await session(u.id);
    const expired = await session(u.id, -1000);
    const revoked = await session(u.id);
    await upsertNativePushDevice(db, u.id, 'android', 'live', null, live);
    await upsertNativePushDevice(db, u.id, 'android', 'expired', null, expired);
    // A registration that raced a revoke: the row exists although its session is already dead.
    await db.execute(
      sql`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = ${revoked}`,
    );
    await upsertNativePushDevice(db, u.id, 'android', 'revoked', null, revoked);
    await upsertWebPushDevice(
      db,
      u.id,
      'https://push.example/web',
      { p256dh: 'k', auth: 'a' },
      null,
    );
    expect(await tokensOf(u.id)).toEqual(['https://push.example/web', 'live']);
  });

  it('revokeFamily removes only that session’s phones', async () => {
    const u = await makeUser('pdint2');
    const [a, b] = [await session(u.id), await session(u.id)];
    await upsertNativePushDevice(db, u.id, 'android', 'a', null, a);
    await upsertNativePushDevice(db, u.id, 'android', 'b', null, b);
    await revokeFamily(db, a);
    expect(await tokensOf(u.id)).toEqual(['b']);
  });

  it('a password reset (revokeAllForUser) removes phones and browsers, not other users’', async () => {
    const [victim, other] = [await makeUser('pdint3'), await makeUser('pdint4')];
    await upsertNativePushDevice(
      db,
      victim.id,
      'android',
      'v-phone',
      null,
      await session(victim.id),
    );
    await upsertWebPushDevice(
      db,
      victim.id,
      'https://push.example/v',
      { p256dh: 'k', auth: 'a' },
      null,
    );
    await upsertWebPushDevice(
      db,
      other.id,
      'https://push.example/o',
      { p256dh: 'k', auth: 'a' },
      null,
    );
    await revokeAllForUser(db, victim.id);
    expect(await tokensOf(victim.id)).toEqual([]);
    expect(await tokensOf(other.id)).toEqual(['https://push.example/o']);
  });
});

describe.skipIf(!hasInfra)('user search by display name (CHAT-012)', () => {
  let db: Database;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await freshDatabase());
    const mk = (username: string, displayName: string) =>
      db.insert(users).values({ username, email: `${username}@test.dev`, displayName });
    await mk('me', 'Me Myself');
    await mk('maria', 'Maria Annenkova');
    await mk('anna', 'Anna B');
    await mk('bob', 'Bob %Real');
    await mk('carl', 'Carl _under');
    await mk('dave', 'Dave Banner');
  });
  afterAll(() => close());

  const find = async (term: string) =>
    (await searchUsersByUsernamePrefix(db, term, randomUUID(), 20)).map((u) => u.username);

  it('matches the start of a username or of any word in the display name', async () => {
    expect(await find('ann')).toEqual(['anna', 'maria']);
    expect(await find('MARIA')).toEqual(['maria']);
  });

  it('does not match inside a word (prefix-only, no substring browsing)', async () => {
    expect(await find('nner')).toEqual([]);
    expect(await find('nenkova')).toEqual([]);
  });

  it('treats % and _ in the term literally', async () => {
    expect(await find('%')).toEqual(['bob']);
    expect(await find('_')).toEqual(['carl']);
    expect(await find('_under')).toEqual(['carl']);
    expect(await find('_x%')).toEqual([]);
  });
});

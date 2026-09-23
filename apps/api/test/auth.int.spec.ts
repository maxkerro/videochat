import { LIMITS } from '@videochat/shared';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { consumeAuthToken, createAuthToken, findValidAuthToken } from '../src/db/auth-tokens.js';
import type { Database } from '../src/db/client.js';
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeAllForUser,
  revokeFamily,
  revokeRefreshToken,
} from '../src/db/refresh-tokens.js';
import { users } from '../src/db/schema.js';
import {
  createUser,
  findUserByEmail,
  isUsernameTaken,
  recordFailedLogin,
  resetFailedLogins,
  updateProfile,
} from '../src/db/users.js';
import { freshDatabase, hasInfra } from './helpers.js';

describe.skipIf(!hasInfra)('auth data layer (CHAT-010, CHAT-011)', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await freshDatabase());
  });
  afterAll(() => close());

  async function makeUser(username: string) {
    return createUser(db, {
      email: `${username}@test.dev`,
      username,
      displayName: username,
      passwordHash: 'x',
    });
  }

  describe('users', () => {
    it('finds a user by email case-insensitively', async () => {
      await makeUser('casey');
      expect(await findUserByEmail(db, 'CASEY@Test.Dev')).toMatchObject({ username: 'casey' });
      expect(await findUserByEmail(db, 'nobody@test.dev')).toBeUndefined();
    });

    it('checks username availability case-insensitively, excluding a given user', async () => {
      const u = await makeUser('dana');
      expect(await isUsernameTaken(db, 'DANA')).toBe(true);
      expect(await isUsernameTaken(db, 'DANA', u.id)).toBe(false);
      expect(await isUsernameTaken(db, 'unused-name')).toBe(false);
    });

    it('updateProfile changes only the given fields', async () => {
      const u = await makeUser('erin');
      const updated = await updateProfile(db, u.id, { displayName: 'Erin New' });
      expect(updated.displayName).toBe('Erin New');
      expect(updated.username).toBe('erin');
    });

    it('locks the account after the configured number of failed logins, then resets', async () => {
      const u = await makeUser('felix');
      let latest: Awaited<ReturnType<typeof recordFailedLogin>>;
      for (let i = 0; i < LIMITS.loginAttemptsBeforeLockout - 1; i++) {
        latest = await recordFailedLogin(db, u.id);
        expect(latest.lockedUntil).toBeNull();
      }
      latest = await recordFailedLogin(db, u.id);
      expect(latest.lockedUntil).not.toBeNull();
      expect(latest.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(latest.failedLoginAttempts).toBe(0); // reset once locked

      await resetFailedLogins(db, u.id);
      const [again] = await db.select().from(users).where(eq(users.id, u.id));
      expect(again?.lockedUntil).toBeNull();
      expect(again?.failedLoginAttempts).toBe(0);
    });

    it('loses no increments when failed logins race (single atomic UPDATE, not read-then-write)', async () => {
      const u = await makeUser('marla');
      // One below the lockout threshold, so every increment should still be visible in the
      // counter rather than having tripped the lockout-reset-to-0 path.
      const concurrentAttempts = LIMITS.loginAttemptsBeforeLockout - 1;
      await Promise.all(
        Array.from({ length: concurrentAttempts }, () => recordFailedLogin(db, u.id)),
      );
      const [row] = await db.select().from(users).where(eq(users.id, u.id));
      // A read-then-write version (SELECT, compute in JS, UPDATE) would lose increments here:
      // every concurrent attempt reads the same starting count and each writes count+1.
      expect(row?.failedLoginAttempts).toBe(concurrentAttempts);
      expect(row?.lockedUntil).toBeNull();
    });
  });

  describe('refresh token rotation under concurrency', () => {
    it('lets only one of two concurrent rotations of the same token succeed', async () => {
      const u = await makeUser('leo');
      const t1 = await createRefreshToken(db, {
        userId: u.id,
        familyId: randomUUID(),
        tokenHash: 'p'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const [firstRevoked, secondRevoked] = await Promise.all([
        revokeRefreshToken(db, t1.id),
        revokeRefreshToken(db, t1.id),
      ]);
      // Exactly one caller "wins" the atomic revoke; the other must see it already gone. If
      // both won, both would go on to mint a live child token from the same parent undetected.
      expect([firstRevoked, secondRevoked].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('refresh tokens', () => {
    it('creates, finds, revokes a single token, and revokes a whole family', async () => {
      const u = await makeUser('gwen');
      const familyId = randomUUID();
      const t1 = await createRefreshToken(db, {
        userId: u.id,
        familyId,
        tokenHash: 'h'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await findRefreshTokenByHash(db, 'h'.repeat(64))).toMatchObject({ id: t1.id });

      await revokeRefreshToken(db, t1.id);
      const revoked = await findRefreshTokenByHash(db, 'h'.repeat(64));
      expect(revoked?.revokedAt).not.toBeNull();

      const t2 = await createRefreshToken(db, {
        userId: u.id,
        familyId,
        tokenHash: 'i'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await revokeFamily(db, familyId);
      expect((await findRefreshTokenByHash(db, 'i'.repeat(64)))?.revokedAt).not.toBeNull();
      void t2;
    });

    it('revokeAllForUser ends every session for that user across families', async () => {
      const u = await makeUser('hollis');
      await createRefreshToken(db, {
        userId: u.id,
        familyId: randomUUID(),
        tokenHash: 'j'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await createRefreshToken(db, {
        userId: u.id,
        familyId: randomUUID(),
        tokenHash: 'k'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await revokeAllForUser(db, u.id);
      expect((await findRefreshTokenByHash(db, 'j'.repeat(64)))?.revokedAt).not.toBeNull();
      expect((await findRefreshTokenByHash(db, 'k'.repeat(64)))?.revokedAt).not.toBeNull();
    });
  });

  describe('auth tokens (email verify / password reset)', () => {
    it('finds a valid token and stops finding it once consumed', async () => {
      const u = await makeUser('iris');
      const created = await createAuthToken(db, {
        userId: u.id,
        purpose: 'email_verify',
        tokenHash: 'm'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await findValidAuthToken(db, 'm'.repeat(64), 'email_verify')).toMatchObject({
        id: created.id,
      });
      // Wrong purpose never matches, even for an otherwise-valid token.
      expect(await findValidAuthToken(db, 'm'.repeat(64), 'password_reset')).toBeUndefined();

      const consumed = await consumeAuthToken(db, 'm'.repeat(64), 'email_verify');
      expect(consumed).toMatchObject({ id: created.id, userId: u.id });
      expect(await findValidAuthToken(db, 'm'.repeat(64), 'email_verify')).toBeUndefined();
      // Double-spend is impossible: a second consume of the same link finds nothing left to
      // consume, rather than silently succeeding again.
      expect(await consumeAuthToken(db, 'm'.repeat(64), 'email_verify')).toBeUndefined();
    });

    it('lets only one of two concurrent consumes of the same token succeed', async () => {
      const u = await makeUser('kara');
      await createAuthToken(db, {
        userId: u.id,
        purpose: 'password_reset',
        tokenHash: 'o'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const [first, second] = await Promise.all([
        consumeAuthToken(db, 'o'.repeat(64), 'password_reset'),
        consumeAuthToken(db, 'o'.repeat(64), 'password_reset'),
      ]);
      const succeeded = [first, second].filter(Boolean);
      expect(succeeded).toHaveLength(1);
    });

    it('does not find an expired token', async () => {
      const u = await makeUser('jonas');
      await createAuthToken(db, {
        userId: u.id,
        purpose: 'password_reset',
        tokenHash: 'n'.repeat(64),
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await findValidAuthToken(db, 'n'.repeat(64), 'password_reset')).toBeUndefined();
    });
  });
});

import { sql, eq, and, ne } from 'drizzle-orm';
import { LIMITS } from '@videochat/shared';
import type { DbExecutor } from './client.js';
import { users, type NewUser, type User } from './schema.js';

export interface CreateUserInput {
  email: string;
  username: string;
  displayName: string;
  passwordHash: string;
}

export function createUser(db: DbExecutor, input: CreateUserInput): Promise<User> {
  return db
    .insert(users)
    .values(input satisfies NewUser)
    .returning()
    .then(([row]) => row!);
}

export async function findUserByEmail(db: DbExecutor, email: string): Promise<User | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row;
}

export async function findUserById(db: DbExecutor, id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

/** Case-insensitive; excludes `excludeUserId` so a user can save their own unchanged username. */
export async function isUsernameTaken(
  db: DbExecutor,
  username: string,
  excludeUserId?: string,
): Promise<boolean> {
  const conditions = [sql`lower(${users.username}) = lower(${username})`];
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId));
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(...conditions))
    .limit(1);
  return row !== undefined;
}

export async function updateProfile(
  db: DbExecutor,
  id: string,
  patch: { username?: string; displayName?: string },
): Promise<User> {
  const [row] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
  if (!row) throw new Error(`User ${id} not found`);
  return row;
}

export async function setAvatarKey(db: DbExecutor, id: string, avatarKey: string): Promise<User> {
  const [row] = await db.update(users).set({ avatarKey }).where(eq(users.id, id)).returning();
  if (!row) throw new Error(`User ${id} not found`);
  return row;
}

export async function markEmailVerified(db: DbExecutor, id: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: sql`now()` })
    .where(eq(users.id, id));
}

export async function setPasswordHash(
  db: DbExecutor,
  id: string,
  passwordHash: string,
): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
}

/**
 * Increments the failed-login counter and, once it reaches the threshold, sets `lockedUntil`
 * and resets the counter so the next window starts fresh after the lockout passes (CHAT-010).
 *
 * This is one atomic UPDATE, not a read-then-write: every expression in a Postgres SET clause
 * sees the same pre-update row, and concurrent UPDATEs to the same row serialize on that row's
 * lock rather than racing. A read-then-write version (SELECT, compute in JS, UPDATE) would lose
 * increments under concurrency -- N parallel wrong-password requests would all read the same
 * count and each write count+1, letting an attacker who parallelizes get far more than
 * `loginAttemptsBeforeLockout` guesses per lockout window.
 */
export async function recordFailedLogin(db: DbExecutor, id: string): Promise<User> {
  const threshold = LIMITS.loginAttemptsBeforeLockout;
  const lockoutMs = LIMITS.loginLockoutMinutes * 60_000;
  const [row] = await db
    .update(users)
    .set({
      failedLoginAttempts: sql`case when ${users.failedLoginAttempts} + 1 >= ${threshold}
        then 0 else ${users.failedLoginAttempts} + 1 end`,
      lockedUntil: sql`case when ${users.failedLoginAttempts} + 1 >= ${threshold}
        then now() + (${lockoutMs} * interval '1 millisecond') else ${users.lockedUntil} end`,
    })
    .where(eq(users.id, id))
    .returning();
  if (!row) throw new Error(`User ${id} not found`);
  return row;
}

export async function resetFailedLogins(db: DbExecutor, id: string): Promise<void> {
  await db.update(users).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, id));
}

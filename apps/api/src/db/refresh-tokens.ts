import { and, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import type { DbExecutor } from './client.js';
import { devices, refreshTokens, type RefreshTokenRow } from './schema.js';

export interface CreateRefreshTokenInput {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
}

export function createRefreshToken(
  db: DbExecutor,
  input: CreateRefreshTokenInput,
): Promise<RefreshTokenRow> {
  return db
    .insert(refreshTokens)
    .values(input)
    .returning()
    .then(([row]) => row!);
}

export async function findRefreshTokenByHash(
  db: DbExecutor,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/**
 * Atomically revokes a token, but only if it hasn't been revoked already: the
 * `revokedAt IS NULL` guard and the `RETURNING` happen as one statement, so concurrent
 * callers racing to revoke the same row can't both believe they won. Returns whether this
 * call was the one that actually revoked it (false means someone else got there first, or
 * it was already revoked).
 */
export async function revokeRefreshToken(db: DbExecutor, id: string): Promise<boolean> {
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length > 0;
}

/** CHAT-055: whether this login session still has a usable (unrevoked, unexpired) token. */
export async function isFamilyLive(db: DbExecutor, familyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Ends every token descended from the same login (a whole session) at once -- and the phone push
 *  tokens registered under that session (CHAT-055). */
export async function revokeFamily(db: DbExecutor, familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  await db.delete(devices).where(eq(devices.sessionFamilyId, familyId));
}

/** Ends every session for a user (e.g. after a password reset), with their phones' push tokens. */
export async function revokeAllForUser(db: DbExecutor, userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  await db
    .delete(devices)
    .where(and(eq(devices.userId, userId), isNotNull(devices.sessionFamilyId)));
}

/** CHAT-037: after a password change, every other session ends; this one (if known) stays. */
export async function revokeAllForUserExcept(
  db: DbExecutor,
  userId: string,
  keepFamilyId: string | null,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        ...(keepFamilyId ? [ne(refreshTokens.familyId, keepFamilyId)] : []),
      ),
    );
  await db
    .delete(devices)
    .where(
      and(
        eq(devices.userId, userId),
        isNotNull(devices.sessionFamilyId),
        ...(keepFamilyId ? [ne(devices.sessionFamilyId, keepFamilyId)] : []),
      ),
    );
}

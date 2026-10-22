import { eq, and, isNull, gt, gte, count } from 'drizzle-orm';
import type { AuthTokenPurpose } from '@videochat/shared';
import type { DbExecutor } from './client.js';
import { authTokens, type AuthTokenRow } from './schema.js';

export interface CreateAuthTokenInput {
  userId: string;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  expiresAt: Date;
}

export function createAuthToken(
  db: DbExecutor,
  input: CreateAuthTokenInput,
): Promise<AuthTokenRow> {
  return db
    .insert(authTokens)
    .values(input)
    .returning()
    .then(([row]) => row!);
}

/** A token that hasn't been consumed and hasn't expired, for the given purpose. Read-only --
 *  for actually spending a token, use `consumeAuthToken`, which checks and consumes in one
 *  statement so two concurrent uses of the same link can't both succeed. */
export async function findValidAuthToken(
  db: DbExecutor,
  tokenHash: string,
  purpose: AuthTokenPurpose,
): Promise<AuthTokenRow | undefined> {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Atomically checks that a token is valid (right purpose, unconsumed, unexpired) and marks it
 * consumed, as a single statement -- not a find-then-consume-by-id, which would let two
 * concurrent requests with the same verify/reset link (e.g. an email client prefetching it, or
 * the user clicking twice) both pass the check and both succeed, double-spending a link that's
 * meant to be single-use. Returns the token row if this call was the one that consumed it,
 * `undefined` if it was already consumed, expired, or never existed.
 */
export async function consumeAuthToken(
  db: DbExecutor,
  tokenHash: string,
  purpose: AuthTokenPurpose,
): Promise<AuthTokenRow | undefined> {
  const [row] = await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  return row;
}

/** CHAT-081: tokens of a purpose created for a user since `since` (consumed or not). */
export async function countRecentAuthTokens(
  db: DbExecutor,
  userId: string,
  purpose: AuthTokenPurpose,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        gte(authTokens.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/** CHAT-081: marks every outstanding token of a purpose used (one sign-in email, one sign-in). */
export async function consumeAllAuthTokens(
  db: DbExecutor,
  userId: string,
  purpose: AuthTokenPurpose,
): Promise<void> {
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, userId),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
      ),
    );
}

/** CHAT-081: voids a user's outstanding sign-in codes after too many wrong guesses (their
 *  links keep working). */
export async function voidLoginCodes(db: DbExecutor, userId: string): Promise<void> {
  await consumeAllAuthTokens(db, userId, 'login_code');
}

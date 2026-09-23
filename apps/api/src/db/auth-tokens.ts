import { eq, and, isNull, gt } from 'drizzle-orm';
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

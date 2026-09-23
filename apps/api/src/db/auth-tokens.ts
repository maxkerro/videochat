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

/** A token that hasn't been consumed and hasn't expired, for the given purpose. */
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

export async function consumeAuthToken(db: DbExecutor, id: string): Promise<void> {
  await db.update(authTokens).set({ consumedAt: new Date() }).where(eq(authTokens.id, id));
}

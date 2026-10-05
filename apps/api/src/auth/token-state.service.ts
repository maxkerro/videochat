import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { DB } from '../infra/tokens.js';

/** How long a node trusts its cached copy. Changes made on this node take effect at once. */
const CACHE_MS = 15_000;

interface UserTokenState {
  exists: boolean;
  deleted: boolean;
  /** Tokens issued (JWT `iat`, seconds) before this second are refused. */
  validFromSec: number;
}

/**
 * CHAT-037 review: an access token is a signed claim, valid until it expires -- unless the account
 * was deleted, or the password changed after the token was issued. This answers "is this token's
 * user still good?" for the HTTP guard and the WebSocket gateway, with a short per-node cache so
 * it isn't a database round trip on every request.
 */
@Injectable()
export class TokenStateService {
  private readonly cache = new Map<string, { state: UserTokenState; at: number }>();

  constructor(@Inject(DB) private readonly db: Database) {}

  async isTokenValid(userId: string, issuedAtSec: number | undefined): Promise<boolean> {
    const state = await this.state(userId);
    if (!state.exists || state.deleted) return false;
    return (issuedAtSec ?? 0) >= state.validFromSec;
  }

  /** Call after deleting an account or changing a password, so this node notices at once. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private async state(userId: string): Promise<UserTokenState> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
    const [row] = await this.db
      .select({ deletedAt: users.deletedAt, passwordChangedAt: users.passwordChangedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const state: UserTokenState = {
      exists: !!row,
      deleted: !!row?.deletedAt,
      validFromSec: row?.passwordChangedAt ? Math.floor(row.passwordChangedAt.getTime() / 1000) : 0,
    };
    this.cache.set(userId, { state, at: Date.now() });
    return state;
  }
}

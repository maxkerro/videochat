import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** A cryptographically random, URL-safe opaque token (refresh tokens, verify/reset links). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of a token. Only this hash is ever stored; the plaintext exists only in
 * the cookie or the emailed link, so a leaked database row can't be replayed.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export { randomUUID };

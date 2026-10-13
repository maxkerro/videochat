import { callRefSchema } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import { newCallId } from './ids';

describe('newCallId', () => {
  it('uses the platform UUID when there is one', () => {
    expect(newCallId(Math.random, { randomUUID: () => 'platform-id' })).toBe('platform-id');
  });

  it('builds a valid v4 UUID from random bytes otherwise', () => {
    for (const cryptoLike of [
      undefined,
      { getRandomValues: <T extends Uint8Array>(a: T) => a.fill(255) },
    ]) {
      const id = newCallId(() => 0.999, cryptoLike);
      expect(callRefSchema.safeParse({ callId: id }).success).toBe(true);
    }
  });

  it('is different every time', () => {
    expect(newCallId(Math.random, undefined)).not.toBe(newCallId(Math.random, undefined));
  });
});

import * as argon2 from '@node-rs/argon2';
import {
  hashPassword,
  resetDummyHashForTests,
  verifyAgainstDummyHash,
  verifyPassword,
} from './password.js';

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>();
  return { ...actual, hash: vi.fn(actual.hash) };
});

describe('password hashing (Argon2id)', () => {
  it('verifies the correct plaintext against its own hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects an incorrect plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same input'), hashPassword('same input')]);
    expect(a).not.toBe(b);
  });

  it('runs a throwaway verify for an unknown account without throwing (CHAT-080)', async () => {
    await expect(verifyAgainstDummyHash('anything')).resolves.toBeUndefined();
    await expect(verifyAgainstDummyHash('')).resolves.toBeUndefined();
  });

  it("never throws, and doesn't cache a failed dummy hash", async () => {
    resetDummyHashForTests();
    vi.mocked(argon2.hash).mockRejectedValueOnce(new Error('out of memory'));
    await expect(verifyAgainstDummyHash('x')).resolves.toBeUndefined();
    const callsAfterFailure = vi.mocked(argon2.hash).mock.calls.length;
    await expect(verifyAgainstDummyHash('x')).resolves.toBeUndefined();
    // Retried the hash instead of reusing the rejected promise...
    expect(vi.mocked(argon2.hash).mock.calls.length).toBe(callsAfterFailure + 1);
    // ...and cached the successful one.
    await verifyAgainstDummyHash('y');
    expect(vi.mocked(argon2.hash).mock.calls.length).toBe(callsAfterFailure + 1);
  });
});

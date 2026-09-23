import { hashPassword, verifyPassword } from './password.js';

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
});

import { generateOpaqueToken, hashToken } from './tokens.js';

describe('generateOpaqueToken', () => {
  it('produces a URL-safe token with no repeats across many calls', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('hashToken', () => {
  it('is deterministic and produces a 64-char hex digest', () => {
    const token = 'a-fixed-token-value';
    const a = hashToken(token);
    const b = hashToken(token);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('one')).not.toBe(hashToken('two'));
  });
});

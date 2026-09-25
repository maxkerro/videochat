import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1).
const PRODUCTION_OPTIONS = {
  algorithm: 2, // Algorithm.Argon2id (a const enum, which isolatedModules can't import)
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// In the test environment (unit and e2e specs, including CI -- vitest sets NODE_ENV=test by
// default), the OWASP-strength cost above is deliberately dropped to Argon2's practical minimum.
// A full run of the api e2e suite signs up dozens of users across 27 spec files, each paying the
// full ~19 MiB/2-pass hash cost; on GitHub's 2-vCPU runners that cumulative CPU load was directly
// implicated in a flaky WebSocket-delivery e2e test timing out near the end of the suite (it's
// 100% reliable run alone, and only flakes as the suite's tail) -- see the "does not deliver a
// message..." test in test/messages.e2e.spec.ts. This still exercises the real hash/verify code
// path and produces genuine (if cheap) Argon2id hashes, so nothing about *what's tested* changes,
// only how long hashing takes. Never reachable outside NODE_ENV=test, so it never weakens a real
// user's password hash.
const TEST_OPTIONS = {
  ...PRODUCTION_OPTIONS,
  memoryCost: 8, // Argon2's minimum for parallelism=1 (8 KiB) -- microseconds instead of milliseconds
  timeCost: 1,
} as const;

const OPTIONS = process.env.NODE_ENV === 'test' ? TEST_OPTIONS : PRODUCTION_OPTIONS;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain);
}

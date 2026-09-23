import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1).
const OPTIONS = {
  algorithm: 2, // Algorithm.Argon2id (a const enum, which isolatedModules can't import)
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain);
}

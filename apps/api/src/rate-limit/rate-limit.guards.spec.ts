import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ThrottlerStorageService, type ThrottlerOptions } from '@nestjs/throttler';
import { MessageThrottlerGuard, SearchThrottlerGuard } from './rate-limit.guards.js';

/** A reflector stub that never finds a route/class override (`@Throttle`/`@SkipThrottle`) --
 *  these tests only exercise the module-level limiter config from `buildRateLimiters`. */
const fakeReflector = { getAllAndOverride: () => undefined } as unknown as Reflector;

function fakeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

type NamedGuard = MessageThrottlerGuard | SearchThrottlerGuard;
type NamedGuardCtor<T extends NamedGuard> = new (
  options: { throttlers: ThrottlerOptions[] },
  storage: ThrottlerStorageService,
  reflector: Reflector,
) => T;

/** Builds a guard already past `onModuleInit` (which is where `NamedThrottlerGuard` narrows
 *  `this.throttlers` down to its own named entry -- see that class's own comment) and wired to a
 *  fresh in-memory storage, so each test starts with a clean counter. */
async function readyGuard<T extends NamedGuard>(
  Guard: NamedGuardCtor<T>,
  throttlers: ThrottlerOptions[],
): Promise<T> {
  const storage = new ThrottlerStorageService();
  const guard = new Guard({ throttlers }, storage, fakeReflector);
  await guard.onModuleInit();
  return guard;
}

describe('MessageThrottlerGuard', () => {
  it('allows requests up to the configured limit, then rejects with a clear "slow down" error', async () => {
    const guard = await readyGuard(MessageThrottlerGuard, [
      { name: 'messages', limit: 3, ttl: 10_000 },
      // A second, much stricter named throttler that must be ignored entirely -- proves
      // `NamedThrottlerGuard` really does narrow to just its own name, not "whichever is
      // strictest" or "all of them".
      { name: 'login', limit: 1, ttl: 10_000 },
    ]);
    const context = fakeContext({ user: { sub: 'user-1' }, ip: '203.0.113.5', headers: {} });

    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      message: "You're sending messages too fast. Slow down and try again in a few seconds.",
      status: 429,
    });
  });

  it('tracks each user separately, so one user hitting the limit never blocks another', async () => {
    const guard = await readyGuard(MessageThrottlerGuard, [
      { name: 'messages', limit: 1, ttl: 10_000 },
    ]);
    const userA = fakeContext({ user: { sub: 'user-a' }, ip: '203.0.113.5', headers: {} });
    const userB = fakeContext({ user: { sub: 'user-b' }, ip: '203.0.113.5', headers: {} });

    expect(await guard.canActivate(userA)).toBe(true);
    await expect(guard.canActivate(userA)).rejects.toBeTruthy();
    // Same IP, different user -- still allowed, since this guard tracks by user id.
    expect(await guard.canActivate(userB)).toBe(true);
  });

  it('reads the limit and window from whatever `buildRateLimiters` produced for "messages"', async () => {
    // Simulates a lower env-configured threshold (CHAT-021 AC: "configurable without a deploy")
    // taking effect immediately, with no change to this guard's own code.
    const guard = await readyGuard(MessageThrottlerGuard, [
      { name: 'messages', limit: 1, ttl: 10_000 },
    ]);
    const context = fakeContext({ user: { sub: 'user-1' }, ip: '203.0.113.5', headers: {} });

    expect(await guard.canActivate(context)).toBe(true);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
  });
});

describe('SearchThrottlerGuard', () => {
  it('falls back to IP-based tracking when there is no authenticated user on the request', async () => {
    const guard = await readyGuard(SearchThrottlerGuard, [
      { name: 'search', limit: 1, ttl: 10_000 },
    ]);
    const anonymous = fakeContext({ ip: '203.0.113.9', headers: {} });

    expect(await guard.canActivate(anonymous)).toBe(true);
    await expect(guard.canActivate(anonymous)).rejects.toMatchObject({
      message: 'Too many searches. Please slow down and try again in a few seconds.',
    });
  });
});

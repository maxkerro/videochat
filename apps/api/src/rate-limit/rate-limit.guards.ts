import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthenticatedRequest } from '../auth/access-token.guard.js';

/**
 * CHAT-021: `ThrottlerGuard` checks *every* named throttler registered with `ThrottlerModule`
 * against any route it guards (see its own `canActivate`, which loops `this.throttlers`), which
 * would mean a route decorated with just one of these subclasses still gets checked against the
 * other two limiters' thresholds too. Each subclass below narrows `this.throttlers` (populated by
 * the base class's `onModuleInit`) down to its own single named entry right after that runs, so
 * attaching e.g. `SearchThrottlerGuard` to a route enforces only the "search" limit -- not
 * "search" *and* "login" *and* "messages".
 */
abstract class NamedThrottlerGuard extends ThrottlerGuard {
  protected abstract readonly limiterName: string;

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((t) => t.name === this.limiterName);
  }
}

/**
 * Shared by the two authenticated limiters (search, message sending): tracks by the signed-in
 * user's id when the request has already passed `AccessTokenGuard` (which must run first --
 * guards attached via the same `@UseGuards(...)` call execute in the order listed), falling back
 * to IP for the rare case this runs unauthenticated. This is the "per user" half of the AC's
 * "per user and per IP" -- see `LoginThrottlerGuard`'s own comment for the "per IP" half and why
 * the two aren't combined into one double-keyed limiter here.
 */
abstract class UserThrottlerGuard extends NamedThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req as unknown as AuthenticatedRequest).user?.sub;
    return userId ?? super.getTracker(req);
  }
}

/**
 * Login has no authenticated user yet to key on, so this tracks by client IP -- the "per IP"
 * half of the AC. (A judgment call: "per user and per IP" is satisfied here by using whichever
 * dimension actually exists for a given endpoint -- IP for the anonymous login attempt, user id
 * for the authenticated search/send endpoints -- rather than stacking two independent limiters on
 * every route. The latter would also rate-limit login by account, which is already CHAT-010's
 * job via `lockedUntil`; this endpoint's own limiter is deliberately IP-only so it adds a
 * different protection -- against many attempts across many accounts from one source -- instead
 * of duplicating that.)
 */
@Injectable()
export class LoginThrottlerGuard extends NamedThrottlerGuard {
  protected readonly limiterName = 'login';

  protected override async getErrorMessage(): Promise<string> {
    return 'Too many login attempts. Please wait a bit and try again.';
  }
}

/** CHAT-012/CHAT-021: "find people" search, rate-limited per signed-in user. */
@Injectable()
export class SearchThrottlerGuard extends UserThrottlerGuard {
  protected readonly limiterName = 'search';

  protected override async getErrorMessage(): Promise<string> {
    return 'Too many searches. Please slow down and try again in a few seconds.';
  }
}

/** CHAT-021: message sending -- the AC's own example ("more than 20 messages in 10 seconds"),
 *  rate-limited per signed-in user. The error message is deliberately specific ("slow down"),
 *  not a generic "too many requests", so the web client can show it to the person as-is rather
 *  than a bare 429 -- see `messagesApi.ts`/`ChatPane.tsx` on the frontend for how it's surfaced. */
@Injectable()
export class MessageThrottlerGuard extends UserThrottlerGuard {
  protected readonly limiterName = 'messages';

  protected override async getErrorMessage(): Promise<string> {
    return "You're sending messages too fast. Slow down and try again in a few seconds.";
  }
}

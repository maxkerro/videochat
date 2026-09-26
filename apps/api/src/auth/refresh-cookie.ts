import type { Response } from 'express';
import type { Env } from '../config/env.js';

export const REFRESH_COOKIE_NAME = 'refresh_token';
/** Scoped to /auth: the cookie is only ever sent back to the refresh/logout endpoints. */
const COOKIE_PATH = '/auth';

/**
 * CHAT-022 CSRF assessment for this cookie: every state-changing endpoint that matters
 * (conversations, messages, group admin actions, blocking, profile edits, ...) is authenticated
 * by the *Bearer access token* in an `Authorization` header (see `AccessTokenGuard`), which the
 * browser never attaches on its own -- a cross-site form or `<img>`/`fetch(..., {mode:'no-cors'})`
 * trick can't forge that header, so those endpoints were never exposed to classic cookie-riding
 * CSRF in the first place. The refresh cookie itself is the one auth-relevant cookie in the app,
 * and it is sent automatically by the browser, so it gets its own two independent mitigations
 * rather than resting on either alone:
 *   1. `sameSite: 'strict'` -- the browser attaches this cookie only to same-site requests, full
 *      stop (stricter than 'lax', which still allows a top-level cross-site GET navigation to
 *      carry it; `/auth/refresh` and `/auth/logout` are POST-only anyway, so 'lax' would already
 *      have blocked a forged request here too -- 'strict' costs nothing since nothing in this app
 *      depends on the cookie surviving a cross-site top-level navigation, e.g. an email link).
 *   2. Strict `CORS_ORIGINS` (see `configureApp`) -- even same-site-cookie quirks aside, a
 *      cross-origin `fetch('/auth/refresh', {credentials:'include'})` from anywhere not on that
 *      list is rejected by the browser's CORS check before the response body (or the rotated
 *      cookie) is ever readable by the attacker's page, and Access-Control-Allow-Credentials is
 *      never sent with a wildcard origin.
 * No separate CSRF token (double-submit or synchronizer) is added on top: it would defend against
 * exactly the same "browser attaches this cookie to a request the user didn't intend" scenario
 * that (1) and (2) already close, at the cost of the SPA having to read and thread a token through
 * every refresh call. See docs/../SECURITY.md's "Session management" section for the full
 * write-up.
 */
export function setRefreshCookie(res: Response, token: string, env: Env): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response, env: Env): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
}

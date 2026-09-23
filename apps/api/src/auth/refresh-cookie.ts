import type { Response } from 'express';
import type { Env } from '../config/env.js';

export const REFRESH_COOKIE_NAME = 'refresh_token';
/** Scoped to /auth: the cookie is only ever sent back to the refresh/logout endpoints. */
const COOKIE_PATH = '/auth';

export function setRefreshCookie(res: Response, token: string, env: Env): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response, env: Env): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
  });
}

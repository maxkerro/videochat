import {
  ApiError,
  REFRESH_MODE_HEADER,
  createApiClient,
  mobileAuthSessionSchema,
  type ApiFetch,
  type LoginInput,
  type MobileAuthSession,
} from '@videochat/shared';
import { z } from 'zod';
import { isNetworkError } from '../lib/errors';
import type { TokenStorage } from './storage';

type User = MobileAuthSession['user'];

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NotSignedInError';
  }
}

/** `offline`: a refresh token is stored but the network was unreachable, so we don't know whether
 *  the session is still valid. `error`: the server answered but not usably (5xx, or a response
 *  the app can't parse). In both cases the token is kept and the caller can retry or log out. */
export type RestoreResult =
  | { status: 'signedIn' }
  | { status: 'signedOut' }
  | { status: 'offline' }
  | { status: 'error'; error: unknown };

/** Refresh a little before the access token actually expires. */
const REFRESH_MARGIN_MS = 30_000;
/** React Native's fetch has no timeout of its own and can hang for minutes on a bad network or a
 *  cell hand-off; the auth calls (login, refresh, logout) are bounded so the UI can never sit on
 *  a spinner forever. */
const AUTH_TIMEOUT_MS = 15_000;
/** How long `logout()` waits for the server to confirm the revoke. The local session is already
 *  gone by then; this only bounds how long the returned promise can take. */
const LOGOUT_WAIT_MS = 3_000;

export interface SessionManagerOptions {
  baseUrl: string;
  storage: TokenStorage;
  fetch?: ApiFetch;
  now?: () => number;
  authTimeoutMs?: number;
  logoutWaitMs?: number;
}

/** Decode the payload of a JWT without verifying it (the server did; we only want its timing). */
function jwtPayload(token: string): { iat?: unknown; exp?: unknown } | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0;
    let acc = 0;
    let out = '';
    for (const c of b64) {
      const v = chars.indexOf(c);
      if (v < 0) continue; // padding
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 0xff);
      }
    }
    return JSON.parse(decodeURIComponent(escape(out))) as { iat?: unknown; exp?: unknown };
  } catch {
    return null;
  }
}

/**
 * How long the access token lives, measured so it doesn't depend on the device clock being right:
 * the token's own `exp - iat` (both server-side) when readable, else the server's expiry minus our
 * clock, clamped to something sane.
 */
export function accessTokenTtlMs(session: MobileAuthSession, nowMs: number): number {
  const payload = jwtPayload(session.accessToken);
  if (
    typeof payload?.iat === 'number' &&
    typeof payload.exp === 'number' &&
    payload.exp > payload.iat
  ) {
    return (payload.exp - payload.iat) * 1000;
  }
  return Math.min(Math.max(Date.parse(session.accessTokenExpiresAt) - nowMs, 0), 24 * 60 * 60_000);
}

/**
 * CHAT-051: the mobile session. The short-lived access token and the user live in memory; the
 * rotating refresh token lives only in the OS keystore (`TokenStorage`) and travels in the body
 * of /auth/refresh and /auth/logout (the API's `X-Refresh-Mode: body`), since there is no cookie
 * jar. Refreshes are single-flight, so a burst of requests rotates the token once.
 */
export function createSessionManager(options: SessionManagerOptions) {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const rawFetch: ApiFetch =
    options.fetch ??
    ((url, init) => (globalThis as unknown as { fetch: ApiFetch }).fetch(url, init));
  const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const logoutWaitMs = options.logoutWaitMs ?? LOGOUT_WAIT_MS;

  /** `rawFetch` that gives up after `authTimeoutMs` (an AbortError, which counts as "offline"). */
  const timedFetch: ApiFetch = (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), authTimeoutMs);
    return rawFetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };

  const authApi = createApiClient({
    baseUrl: options.baseUrl,
    fetch: timedFetch,
    getHeaders: () => ({ [REFRESH_MODE_HEADER]: 'body' }),
  });

  /** Ask the server to end the session behind a refresh token. Never throws. */
  const revoke = (token: string): Promise<void> =>
    authApi
      .apiPost('/auth/logout', z.unknown(), { refreshToken: token })
      .then(() => undefined)
      .catch(() => undefined);

  let accessToken: string | null = null;
  let expiresAt = 0;
  let user: User | null = null;
  let inFlight: Promise<MobileAuthSession> | null = null;
  // Bumped whenever the session is replaced or ended (login, logout, rejected token). A refresh
  // that started under an older generation must not write its result back: it would resurrect a
  // session the user just logged out of, or overwrite a newer login.
  let generation = 0;
  const listeners = new Set<() => void>();
  const signedOutListeners = new Set<() => void | Promise<void>>();

  const notify = () => listeners.forEach((l) => l());

  function apply(session: MobileAuthSession) {
    accessToken = session.accessToken;
    expiresAt = now() + accessTokenTtlMs(session, now());
    user = session.user;
    notify();
  }

  async function clearLocal() {
    generation += 1;
    accessToken = null;
    expiresAt = 0;
    user = null;
    await storage.clear();
    await Promise.allSettled([...signedOutListeners].map((l) => l()));
    notify();
  }

  function refreshNow(): Promise<MobileAuthSession> {
    inFlight ??= (async () => {
      const startedAt = generation;
      const stored = await storage.getRefreshToken();
      if (!stored) {
        await clearLocal();
        throw new NotSignedInError();
      }
      try {
        const session = await authApi.apiPost('/auth/refresh', mobileAuthSessionSchema, {
          refreshToken: stored,
        });
        // The session ended or was replaced while this was in flight: drop the result -- and end
        // the session the server just rotated into, which nobody holds any more.
        if (generation !== startedAt) {
          void revoke(session.refreshToken);
          throw new NotSignedInError();
        }
        // Persist the rotated token before anything else: the old one is already dead.
        await storage.setRefreshToken(session.refreshToken);
        apply(session);
        return session;
      } catch (e) {
        if (e instanceof NotSignedInError) throw e;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          // Only end the session this refresh belongs to, never a newer login.
          if (generation === startedAt) await clearLocal();
          throw new NotSignedInError();
        }
        throw e; // offline, timeout, 5xx: keep the token and let the caller decide
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function getAccessToken(): Promise<string> {
    if (accessToken && now() < expiresAt - REFRESH_MARGIN_MS) return accessToken;
    if (!accessToken && !(await storage.getRefreshToken())) throw new NotSignedInError();
    return (await refreshNow()).accessToken;
  }

  /** `fetch` for the API client: adds the bearer token, and on a 401 refreshes once and retries. */
  const authedFetch: ApiFetch = async (url, init) => {
    const send = (token: string) =>
      rawFetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    const res = await send(await getAccessToken());
    if (res.status !== 401) return res;
    return send((await refreshNow()).accessToken);
  };

  return {
    authedFetch,
    getAccessToken,
    getUser: () => user,
    isSignedIn: () => user !== null,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Runs when the session ends (logout, or the server rejecting the refresh token). The place
     *  to wipe the local message cache (CHAT-053). */
    onSignedOut(listener: () => void | Promise<void>) {
      signedOutListeners.add(listener);
      return () => signedOutListeners.delete(listener);
    },

    async login(input: LoginInput): Promise<MobileAuthSession> {
      const session = await authApi.apiPost('/auth/login', mobileAuthSessionSchema, input);
      generation += 1;
      await storage.setRefreshToken(session.refreshToken);
      apply(session);
      return session;
    },

    /** On app start: turn a stored refresh token back into a session. */
    async restore(): Promise<RestoreResult> {
      if (!(await storage.getRefreshToken())) return { status: 'signedOut' };
      try {
        await refreshNow();
        return { status: 'signedIn' };
      } catch (e) {
        if (e instanceof NotSignedInError) return { status: 'signedOut' };
        return isNetworkError(e) ? { status: 'offline' } : { status: 'error', error: e };
      }
    },

    /** Bumped whenever the session is replaced or ended. Anything that writes per-user state after
     *  an `await` (the message cache, CHAT-053) should capture this first and drop its write if it
     *  changed, so user A's late response can't land in user B's cache. */
    generation: () => generation,

    async logout(): Promise<void> {
      const stored = await storage.getRefreshToken();
      // End the local session first and unconditionally: the UI is signed out at once, a refresh
      // still in flight is now stale (it revokes whatever it rotated to), and nothing below can
      // keep the user signed in -- however badly the network is behaving.
      await clearLocal();
      if (stored) {
        // Best effort, and bounded: the revoke can finish after we return.
        await Promise.race([revoke(stored), new Promise((r) => setTimeout(r, logoutWaitMs))]);
      }
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;

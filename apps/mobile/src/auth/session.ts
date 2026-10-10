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
import type { TokenStorage } from './storage';

type User = MobileAuthSession['user'];

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NotSignedInError';
  }
}

/** `offline`: a refresh token is stored but the server couldn't be reached, so we don't know
 *  whether the session is still valid. The user stays signed in; the caller can retry. */
export type RestoreResult = 'signedIn' | 'signedOut' | 'offline';

/** Refresh a little before the access token actually expires. */
const REFRESH_MARGIN_MS = 30_000;

export interface SessionManagerOptions {
  baseUrl: string;
  storage: TokenStorage;
  fetch?: ApiFetch;
  now?: () => number;
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

  const authApi = createApiClient({
    baseUrl: options.baseUrl,
    fetch: rawFetch,
    getHeaders: () => ({ [REFRESH_MODE_HEADER]: 'body' }),
  });

  let accessToken: string | null = null;
  let expiresAt = 0;
  let user: User | null = null;
  let inFlight: Promise<MobileAuthSession> | null = null;
  const listeners = new Set<() => void>();
  const signedOutListeners = new Set<() => void | Promise<void>>();

  const notify = () => listeners.forEach((l) => l());

  function apply(session: MobileAuthSession) {
    accessToken = session.accessToken;
    expiresAt = Date.parse(session.accessTokenExpiresAt);
    user = session.user;
    notify();
  }

  async function clearLocal() {
    accessToken = null;
    expiresAt = 0;
    user = null;
    await storage.clear();
    await Promise.allSettled([...signedOutListeners].map((l) => l()));
    notify();
  }

  function refreshNow(): Promise<MobileAuthSession> {
    inFlight ??= (async () => {
      const stored = await storage.getRefreshToken();
      if (!stored) {
        await clearLocal();
        throw new NotSignedInError();
      }
      try {
        const session = await authApi.apiPost('/auth/refresh', mobileAuthSessionSchema, {
          refreshToken: stored,
        });
        // Persist the rotated token before anything else: the old one is already dead.
        await storage.setRefreshToken(session.refreshToken);
        apply(session);
        return session;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          await clearLocal();
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
      await storage.setRefreshToken(session.refreshToken);
      apply(session);
      return session;
    },

    /** On app start: turn a stored refresh token back into a session. */
    async restore(): Promise<RestoreResult> {
      if (!(await storage.getRefreshToken())) return 'signedOut';
      try {
        await refreshNow();
        return 'signedIn';
      } catch (e) {
        if (e instanceof NotSignedInError) return 'signedOut';
        return 'offline';
      }
    },

    async logout(): Promise<void> {
      const stored = await storage.getRefreshToken();
      if (stored) {
        // Best effort: even if the server can't be reached, the local session still ends.
        await authApi
          .apiPost('/auth/logout', z.unknown(), { refreshToken: stored })
          .catch(() => undefined);
      }
      await clearLocal();
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;

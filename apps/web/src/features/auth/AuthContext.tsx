import { useQueryClient } from '@tanstack/react-query';
import {
  authSessionSchema,
  loginSchema,
  type AuthSession,
  type LoginInput,
  type Me,
} from '@videochat/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiPost, ApiError } from '../../lib/api';
import { messageResponseSchema } from './authApi';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: Me | null;
  accessToken: string | null;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Silently exchanges the httpOnly refresh cookie for a new session. Resolves to the new
   *  access token, or null if there was no valid session to refresh. */
  refresh: () => Promise<string | null>;
  /** Updates the cached user (e.g. after a profile edit or avatar upload) without a refresh. */
  setUser: (user: Me) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Owns the in-memory access token and current user (CHAT-010). The refresh token itself never
 * touches JS -- it lives only in the httpOnly cookie the API sets, so a silent refresh on mount
 * is how a returning visitor picks their session back up.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  // Avoids two overlapping silent-refresh attempts (e.g. StrictMode's double-invoked effect).
  const refreshing = useRef<Promise<string | null> | null>(null);
  // None of the query keys used across the app (['conversations'], ['conversation', id],
  // ['messages', id], ...) are scoped by user id, since there's normally only ever one signed-in
  // user per browser session. Without clearing on logout/login, a second person signing in on the
  // same tab right after the first signs out would briefly see the previous person's cached
  // conversations and messages before anything refetches.
  const queryClient = useQueryClient();

  const refresh = useCallback(async (): Promise<string | null> => {
    if (refreshing.current) return refreshing.current;
    const attempt = (async () => {
      try {
        const next = await apiPost('/auth/refresh', authSessionSchema);
        setSession(next);
        return next.accessToken;
      } catch {
        setSession(null);
        return null;
      }
    })();
    refreshing.current = attempt;
    try {
      return await attempt;
    } finally {
      refreshing.current = null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (input: LoginInput) => {
      loginSchema.parse(input);
      const next = await apiPost('/auth/login', authSessionSchema, input);
      // Clear rather than merge: this only matters when someone else's session was left behind
      // in this tab (normally login only happens from anonymous), but it's cheap and correct
      // either way -- everything refetches fresh for whoever is signed in now.
      queryClient.clear();
      setSession(next);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await apiPost('/auth/logout', messageResponseSchema);
    } catch {
      // The server call is a courtesy (it revokes the refresh-token family server-side); whether
      // it fails because the session was already gone, the network dropped, or the response
      // didn't match the expected shape, the client still forgets the session locally.
    } finally {
      setSession(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const setUser = useCallback((user: Me) => {
    setSession((prev) => (prev ? { ...prev, user } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: session === undefined ? 'loading' : session ? 'authenticated' : 'anonymous',
      user: session?.user ?? null,
      accessToken: session?.accessToken ?? null,
      login,
      logout,
      refresh,
      setUser,
    }),
    [session, login, logout, refresh, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Runs an authenticated request, retrying it once with a fresh access token if the first
 * attempt is rejected as unauthorized (e.g. the 15-minute access token just expired).
 */
export async function withAuthRetry<T>(
  auth: Pick<AuthContextValue, 'accessToken' | 'refresh'>,
  send: (accessToken: string) => Promise<T>,
): Promise<T> {
  if (!auth.accessToken) throw new ApiError(401, 'Not authenticated');
  try {
    return await send(auth.accessToken);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const fresh = await auth.refresh();
      if (fresh) return send(fresh);
    }
    throw err;
  }
}

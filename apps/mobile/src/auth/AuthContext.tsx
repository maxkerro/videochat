import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { session } from '../lib/api';

type User = NonNullable<ReturnType<typeof session.getUser>>;

export type AuthState =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: User };

interface AuthContextValue {
  state: AuthState;
  /** Retry restoring the session after it failed with no connection. */
  retry: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [restored, setRestored] = useState<'loading' | 'offline' | 'done'>('loading');
  // The session manager owns the truth (login, refresh failures and logout all change it).
  const user = useSyncExternalStore(session.subscribe, session.getUser);

  const restore = useCallback(() => {
    void session.restore().then((result) => setRestored(result === 'offline' ? 'offline' : 'done'));
  }, []);

  useEffect(restore, [restore]);

  const retry = useCallback(() => {
    setRestored('loading');
    restore();
  }, [restore]);

  const value = useMemo<AuthContextValue>(() => {
    const state: AuthState = user
      ? { status: 'signedIn', user }
      : restored === 'done'
        ? { status: 'signedOut' }
        : { status: restored };
    return { state, retry, logout: () => session.logout() };
  }, [user, restored, retry]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

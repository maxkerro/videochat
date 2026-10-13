import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { session } from '../lib/api';
import { unregisterToken } from '../push/registration';
import { describeError } from '../ui/describeError';

type User = NonNullable<ReturnType<typeof session.getUser>>;

export type AuthState =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'error'; message: string }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: User };

interface AuthContextValue {
  state: AuthState;
  /** Retry restoring the session after it failed (offline, or an unusable server answer). */
  retry: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [restored, setRestored] = useState<
    { status: 'loading' | 'offline' | 'done' } | { status: 'error'; message: string }
  >({ status: 'loading' });
  // The session manager owns the truth (login, refresh failures and logout all change it).
  const user = useSyncExternalStore(session.subscribe, session.getUser);

  // Only the latest restore may set the state: a Retry that overlaps an earlier, slower restore
  // must not be overwritten by it.
  const restoreSeq = useRef(0);

  const restore = useCallback(() => {
    const seq = ++restoreSeq.current;
    void session.restore().then((result) => {
      if (seq !== restoreSeq.current) return;
      if (result.status === 'offline') setRestored({ status: 'offline' });
      else if (result.status === 'error')
        setRestored({ status: 'error', message: describeError(result.error) });
      else setRestored({ status: 'done' });
    });
  }, []);

  useEffect(restore, [restore]);

  const retry = useCallback(() => {
    setRestored({ status: 'loading' });
    restore();
  }, [restore]);

  const value = useMemo<AuthContextValue>(() => {
    const state: AuthState = user
      ? { status: 'signedIn', user }
      : restored.status === 'done'
        ? { status: 'signedOut' }
        : restored.status === 'error'
          ? { status: 'error', message: restored.message }
          : { status: restored.status };
    return {
      state,
      retry,
      // Also reachable from the offline/error screens, where there is no user yet.
      logout: async () => {
        // A Retry still in flight must not bring the offline screen back after this.
        restoreSeq.current++;
        // While the session can still authenticate: stop pushing this account to this phone.
        await unregisterToken();
        await session.logout();
        setRestored({ status: 'done' });
      },
    };
  }, [user, restored, retry]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

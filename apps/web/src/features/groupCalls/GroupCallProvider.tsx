import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useToast } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useCalls } from '../calls/CallProvider';
import { joinGroupCall } from './groupCallsApi';

// The SFU client is big and only needed in a call: loaded on first join.
const GroupCallView = lazy(() => import('./GroupCallView'));

export interface GroupCallSession {
  callId: string;
  conversationId: string;
  title: string;
  url: string;
  token: string;
}

export interface GroupCallController {
  session: GroupCallSession | null;
  joining: string | null;
  /** Start the group's call, or join the running one. */
  join: (conversationId: string, title: string) => Promise<void>;
  leave: () => void;
}

export const GroupCallContext = createContext<GroupCallController | null>(null);

export function useGroupCall(): GroupCallController {
  const ctx = useContext(GroupCallContext);
  if (!ctx) throw new Error('useGroupCall must be used inside <GroupCallProvider>');
  return ctx;
}

/** For places that also render outside the provider (tests): null there. */
export function useOptionalGroupCall(): GroupCallController | null {
  return useContext(GroupCallContext);
}

/** Why joining failed, in words for a toast. */
export function joinErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return err.message;
    if (err.status === 503) return 'Group calls aren’t available right now.';
    if (err.status === 404) return 'This chat no longer exists.';
  }
  return 'Couldn’t join the call. Please try again.';
}

/**
 * CHAT-070: the one group call this tab can be in. Above the router like the 1:1 calls, so the
 * call keeps going while the person moves around the app. One kind of call at a time: a group
 * call can't start during a 1:1 call (and the 1:1 call buttons are off during a group call).
 */
export function GroupCallProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const calls = useCalls();
  const { toast } = useToast();
  // The session belongs to the person who joined: it is only ever shown to them, and it is
  // dropped when they sign out, so the next person signing in on this tab never inherits it.
  const [joined, setJoined] = useState<{ userId: string; session: GroupCallSession } | null>(null);
  const userId = auth.status === 'anonymous' ? null : (auth.user?.id ?? null);
  // Signed out (or someone else signed in): forget it for good, so signing back in later doesn't
  // reconnect either. (Adjusting state while rendering, React's pattern for "reset on change".)
  if (joined && joined.userId !== userId) setJoined(null);
  const session = joined && joined.userId === userId ? joined.session : null;
  const [joining, setJoining] = useState<string | null>(null);
  const inOneToOne = calls.call !== null && calls.call.phase !== 'ended';

  const join = useCallback(
    async (conversationId: string, title: string) => {
      if (session?.conversationId === conversationId) return;
      if (session || inOneToOne) {
        toast({ title: 'Already in a call', description: 'Finish your current call first.' });
        return;
      }
      setJoining(conversationId);
      try {
        const res = await withAuthRetry(auth, (token) => joinGroupCall(token, conversationId));
        if (!userId) return;
        setJoined({
          userId,
          session: { callId: res.call.id, conversationId, title, url: res.url, token: res.token },
        });
      } catch (err) {
        toast({ title: joinErrorText(err), tone: 'danger' });
      } finally {
        setJoining(null);
      }
    },
    [auth, inOneToOne, session, toast, userId],
  );

  const leave = useCallback(() => setJoined(null), []);

  const value = useMemo(() => ({ session, joining, join, leave }), [session, joining, join, leave]);

  return (
    <GroupCallContext.Provider value={value}>
      {children}
      {session && (
        <Suspense fallback={null}>
          <GroupCallView session={session} onLeave={leave} />
        </Suspense>
      )}
    </GroupCallContext.Provider>
  );
}

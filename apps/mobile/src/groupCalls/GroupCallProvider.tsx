import { ApiError } from '@videochat/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { useCalls } from '../calls/CallProvider';
import { describeError } from '../ui/describeError';
import { joinGroupCall } from './groupCallsApi';
import { GroupCallScreen } from './GroupCallScreen';

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
  join: (conversationId: string, title: string) => Promise<void>;
  leave: () => void;
}

const GroupCallContext = createContext<GroupCallController | null>(null);

export function useGroupCall(): GroupCallController {
  const ctx = useContext(GroupCallContext);
  if (!ctx) throw new Error('useGroupCall must be used inside <GroupCallProvider>');
  return ctx;
}

/** Why joining failed, for an alert. */
export function joinErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 503)
    return 'Group calls aren’t available right now.';
  return describeError(err);
}

/**
 * CHAT-070: the one group call this phone can be in, drawn over the app like the 1:1 call
 * screen. One kind of call at a time: no group call during a 1:1 call, and the 1:1 call buttons
 * refuse while a group call runs.
 */
export function GroupCallProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const calls = useCalls();
  // The session belongs to the person who joined; signing out drops it for good, so whoever signs
  // in next on this phone never inherits it (whatever the routing does with this provider).
  const [joined, setJoined] = useState<{ userId: string; session: GroupCallSession } | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const signedOut = state.status === 'signedOut';
  const userId = state.status === 'signedIn' ? state.user.id : null;
  // Dropped for good on sign-out or when someone else signs in (as on the web); a moment without a
  // known user while not signed out (loading) leaves it alone.
  const otherUser = userId !== null && joined !== null && joined.userId !== userId;
  if (joined && (signedOut || otherUser)) setJoined(null);
  const session = joined && !signedOut && !otherUser ? joined.session : null;
  const inOneToOne = calls.call !== null && calls.call.phase !== 'ended';

  const join = useCallback(
    async (conversationId: string, title: string) => {
      if (session?.conversationId === conversationId) return;
      if (session || inOneToOne) {
        Alert.alert('Already in a call', 'Finish your current call first.');
        return;
      }
      // Not signed in as a known person (yet): nothing to join as.
      if (!userId) return;
      setJoining(conversationId);
      try {
        const res = await joinGroupCall(conversationId);
        setJoined({
          userId,
          session: { callId: res.call.id, conversationId, title, url: res.url, token: res.token },
        });
      } catch (err) {
        Alert.alert('Can’t join the call', joinErrorText(err));
      } finally {
        setJoining(null);
      }
    },
    [session, inOneToOne, userId],
  );

  const leave = useCallback(() => setJoined(null), []);
  const value = useMemo(() => ({ session, joining, join, leave }), [session, joining, join, leave]);

  return (
    <GroupCallContext.Provider value={value}>
      {children}
      {session ? <GroupCallScreen session={session} onLeave={leave} /> : null}
    </GroupCallContext.Provider>
  );
}

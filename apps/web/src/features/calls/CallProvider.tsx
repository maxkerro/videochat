import type { CallMedia } from '@videochat/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useToast } from '../../components/ui';
import { useAuth, withAuthRetry, type AuthContextValue } from '../auth/AuthContext';
import { useRealtime } from '../chat/RealtimeProvider';
import { fetchIceServers } from './callsApi';
import { CallEngine, type CallEndCause, type CallPeer, type CallSnapshot } from './CallEngine';

export interface CallController {
  call: CallSnapshot | null;
  /** Full call screen vs. the minimised bar (CHAT-042: the call survives navigating elsewhere). */
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  startCall: (args: {
    conversationId: string;
    peer: CallPeer;
    media: CallMedia;
    stream: MediaStream;
  }) => void;
  accept: (stream: MediaStream) => Promise<void>;
  decline: () => void;
  hangUp: () => void;
  toggleAudio: () => void;
  toggleVideo: () => Promise<void>;
  switchDevice: (kind: 'audioinput' | 'videoinput', deviceId: string) => Promise<void>;
}

export const CallContext = createContext<CallController | null>(null);

export function useCalls(): CallController {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCalls must be used inside <CallProvider>');
  return ctx;
}

/** What to tell the person when a call ends, if anything. `null` = nothing worth a toast. */
export function endMessage(
  call: Pick<CallSnapshot, 'direction' | 'peer' | 'startedAt'>,
  cause: CallEndCause,
  now: number,
): string | null {
  const name = call.peer.displayName;
  switch (cause) {
    case 'missed':
      return call.direction === 'outgoing' ? `${name} didn’t answer` : `Missed call from ${name}`;
    case 'declined':
      return call.direction === 'outgoing' ? `${name} declined the call` : null;
    case 'busy':
      return `${name} is on another call`;
    case 'unavailable':
      return `You can’t call ${name} right now`;
    case 'cancelled':
      return call.direction === 'incoming' ? `Missed call from ${name}` : null;
    case 'answered-elsewhere':
      return 'Answered on another device';
    case 'connection-lost':
    case 'failed':
      return 'The call was disconnected';
    case 'completed':
      return call.startedAt !== null
        ? `Call ended · ${formatDuration(now - call.startedAt)}`
        : 'Call ended';
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Builds the engine with real browser WebRTC/media. It outlives renders, so it reads the latest
 *  auth (for fetching ICE servers) from closure state updated through `setAuth`, the same way
 *  RealtimeProvider hands its client the latest token. */
function createBrowserCallEngine(realtime: ReturnType<typeof useRealtime>) {
  let auth: Pick<AuthContextValue, 'accessToken' | 'refresh'> | null = null;
  const engine = new CallEngine({
    send: (type, payload) => realtime.send(type, payload),
    getConnectionId: () => realtime.getConnectionId(),
    getIceServers: () =>
      auth ? withAuthRetry(auth, fetchIceServers).then((r) => r.iceServers) : Promise.resolve([]),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: (config) => new RTCPeerConnection(config),
    createMediaStream: () => new MediaStream(),
    now: () => Date.now(),
    newCallId: () => crypto.randomUUID(),
  });
  return {
    engine,
    setAuth: (next: Pick<AuthContextValue, 'accessToken' | 'refresh'>) => {
      auth = next;
    },
  };
}

/**
 * CHAT-042: owns the single call this tab can be in. Lives above the router so a call keeps
 * going while the person moves between chats (or to their profile); the remote audio plays from
 * an element rendered here for the same reason -- the visible call UI can unmount without the
 * other person going silent.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const realtime = useRealtime();
  const auth = useAuth();
  const { toast } = useToast();
  const [{ engine, setAuth }] = useState(() => createBrowserCallEngine(realtime));
  useEffect(() => {
    setAuth(auth);
  }, [setAuth, auth]);
  const call = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [expanded, setExpanded] = useState(true);

  useEffect(
    () => realtime.subscribe((envelope) => engine.handleEvent(envelope)),
    [realtime, engine],
  );

  // Signing out mid-call hangs up rather than leaving the other person talking to nobody.
  useEffect(() => {
    if (auth.status === 'anonymous') engine.hangUp();
  }, [auth.status, engine]);

  // Announce how it ended, then clear it so the call UI goes away.
  useEffect(() => {
    if (call?.phase !== 'ended' || !call.endCause) return;
    const message = endMessage(call, call.endCause, Date.now());
    if (message) toast({ title: message, tone: call.endCause === 'failed' ? 'danger' : 'neutral' });
    engine.dismiss();
  }, [call, engine, toast]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteStream = call?.remoteStream ?? null;
  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const startCall = useCallback<CallController['startCall']>(
    (args) => {
      engine.startOutgoing(args);
      setExpanded(true);
    },
    [engine],
  );

  const accept = useCallback(
    async (stream: MediaStream) => {
      setExpanded(true);
      await engine.accept(stream);
    },
    [engine],
  );

  const value = useMemo<CallController>(
    () => ({
      call,
      expanded,
      setExpanded,
      startCall,
      accept,
      decline: () => engine.decline(),
      hangUp: () => engine.hangUp(),
      toggleAudio: () => engine.toggleAudio(),
      toggleVideo: () => engine.toggleVideo(),
      switchDevice: (kind, deviceId) => engine.switchDevice(kind, deviceId),
    }),
    [call, expanded, startCall, accept, engine],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Remote audio for the whole call, independent of which screen is showing. */}
      <audio ref={audioRef} autoPlay hidden data-testid="call-remote-audio" />
    </CallContext.Provider>
  );
}

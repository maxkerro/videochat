import NetInfo from '@react-native-community/netinfo';
import type { CallMedia } from '@videochat/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Alert, Linking } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { getRealtimeStatus } from '../realtime/status';
import { getConnectionId, subscribeRealtime } from '../realtime/connection';
import { setCallActive } from './activity';
import { CallBusyError, CallEngine, type CallPeer, type CallSnapshot } from './CallEngine';
import { endMessage } from './endMessage';
import {
  acquireMedia,
  CAMERA_OFF_NOTICE,
  describeMediaProblem,
  CAMERA_CONSTRAINTS,
  MediaAccessError,
  type MediaSource,
} from './media';
import { nativeCallDeps, nativeMedia } from './nativeDeps';
import type { RtcStream } from './rtc';

/** How long "Call ended" stays up before the call screen goes away. */
export const ENDED_LINGER_MS = 2_000;

export interface CallController {
  call: CallSnapshot | null;
  /** What the screen says once the call is over (null while it is going on, or if nothing to say). */
  endedText: string | null;
  startCall: (args: { conversationId: string; peer: CallPeer; media: CallMedia }) => Promise<void>;
  /** `media: 'audio'` answers a video call without sending video. */
  accept: (media: CallMedia) => Promise<void>;
  decline: () => void;
  hangUp: () => void;
  toggleAudio: () => void;
  toggleVideo: () => Promise<void>;
  switchCamera: () => void;
}

const CallContext = createContext<CallController | null>(null);

export function useCalls(): CallController {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCalls must be used inside <CallProvider>');
  return ctx;
}

function explainMediaProblem(error: unknown): void {
  if (!(error instanceof MediaAccessError)) {
    Alert.alert('Can’t start the call', 'Something went wrong. Please try again.');
    return;
  }
  const info = describeMediaProblem(error.problem);
  Alert.alert(
    info.title,
    info.message,
    info.openSettings
      ? [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => void Linking.openSettings() },
        ]
      : [{ text: 'OK' }],
  );
}

function explainCameraOff(): void {
  Alert.alert(CAMERA_OFF_NOTICE.title, CAMERA_OFF_NOTICE.message, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Open settings', onPress: () => void Linking.openSettings() },
  ]);
}

/**
 * CHAT-060: owns the one call this phone can be in. It lives above the screens, so the call goes
 * on while the person moves around the app; the call screen itself is drawn over everything by
 * `CallOverlay`.
 */
export function CallProvider({
  children,
  media = nativeMedia,
}: {
  children: ReactNode;
  media?: MediaSource;
}) {
  const { state } = useAuth();
  const [engine] = useState(() => new CallEngine(nativeCallDeps()));
  const call = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  useEffect(
    () =>
      subscribeRealtime((envelope) => {
        // A (re)connected socket is registered server-side once `realtime.ready` arrives -- only
        // then can it re-attach to a call in progress (CHAT-043).
        if (envelope.type === 'realtime.ready') engine.onSignallingReconnected();
        engine.handleEvent(envelope);
      }),
    [engine],
  );

  // Wi-Fi <-> mobile data and similar: find a new media path right away (CHAT-043).
  useEffect(() => {
    let previous: string | null = null;
    return NetInfo.addEventListener((s) => {
      const key = `${s.type}:${s.isConnected === true}`;
      if (previous !== null && previous !== key && s.isConnected !== false)
        engine.onNetworkChange();
      previous = key;
    });
  }, [engine]);

  // The realtime provider keeps the socket open in the background while this is true.
  const busy = call !== null && call.phase !== 'ended';
  useEffect(() => {
    setCallActive(busy);
    return () => setCallActive(false);
  }, [busy]);

  // Signing out mid-call hangs up rather than leaving the other person talking to nobody.
  const signedIn = state.status === 'signedIn';
  useEffect(() => {
    if (!signedIn) engine.hangUp();
  }, [signedIn, engine]);

  // Say how it ended for a moment, then clear the screen.
  const ended = call?.phase === 'ended';
  const endedText = useMemo(
    () =>
      call && ended && call.endCause ? endMessage(call, call.endCause, call.endedAt ?? 0) : null,
    [call, ended],
  );
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => engine.dismiss(), ENDED_LINGER_MS);
    return () => clearTimeout(timer);
  }, [ended, engine]);

  const startCall = useCallback<CallController['startCall']>(
    async ({ conversationId, peer, media: kind }) => {
      if (engine.isBusy()) {
        Alert.alert('Already in a call', 'Finish your current call first.');
        return;
      }
      // The invite travels over the live socket: without it nothing would ring.
      if (getRealtimeStatus() !== 'open' || getConnectionId() === null) {
        Alert.alert(
          'Can’t call right now',
          'You’re not connected. Check your connection and try again.',
        );
        return;
      }
      try {
        const { stream, cameraMissing } = await acquireMedia(media, kind);
        try {
          engine.startOutgoing({ conversationId, peer, media: kind, stream });
        } catch (error) {
          for (const track of stream.getTracks()) track.stop();
          if (!(error instanceof CallBusyError)) throw error;
          return;
        }
        if (cameraMissing) explainCameraOff();
      } catch (error) {
        explainMediaProblem(error);
      }
    },
    [engine, media],
  );

  const accept = useCallback(
    async (kind: CallMedia) => {
      try {
        const { stream, cameraMissing } = await acquireMedia(media, kind);
        await engine.accept(stream as RtcStream);
        if (cameraMissing) explainCameraOff();
      } catch (error) {
        // Could not get the microphone: leave the call ringing so it can still be declined.
        explainMediaProblem(error);
      }
    },
    [engine, media],
  );

  const value = useMemo<CallController>(
    () => ({
      call,
      endedText,
      startCall,
      accept,
      decline: () => engine.decline(),
      hangUp: () => engine.hangUp(),
      toggleAudio: () => engine.toggleAudio(),
      toggleVideo: async () => {
        try {
          await engine.toggleVideo({ ...CAMERA_CONSTRAINTS });
        } catch {
          // Turning the camera on needs its permission; explain how to grant it.
          explainCameraOff();
        }
      },
      switchCamera: () => engine.switchCamera(),
    }),
    [call, endedText, startCall, accept, engine],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

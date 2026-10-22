import NetInfo from '@react-native-community/netinfo';
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
import { Alert, AppState, Linking } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { getRealtimeStatus } from '../realtime/status';
import { getConnectionId, subscribeRealtime, waitForRealtime } from '../realtime/connection';
import { setCallActive } from './activity';
import { AudioSession, type AudioRoute, type AudioSnapshot } from './audioRoute';
import {
  BACKGROUND_PAUSE_DELAY_MS,
  hasLiveAudio,
  isVideoCall,
  wantsPictureInPicture,
} from './callMode';
import { CallBridge } from './callBridge';
import { CallBusyError, CallEngine, type CallPeer, type CallSnapshot } from './CallEngine';
import { endMessage } from './endMessage';
import { noiseSuppressionOn } from './callPrefs';
import {
  acquireMedia,
  CAMERA_OFF_NOTICE,
  describeMediaProblem,
  CAMERA_CONSTRAINTS,
  MediaAccessError,
  type MediaSource,
} from './media';
import { nativeAudioDriver, requestBluetoothPermission } from './nativeAudio';
import { ProximityGuard } from './proximity';
import { proximityScreen } from '../../modules/proximity-screen';
import { blur } from './nativeBlur';
import { nativeCallApi } from './nativeCallUi';
import { nativeCallDeps, nativeMedia, SIGNALLING_WAIT_MS } from './nativeDeps';
import { pip, useIsInPip } from './nativePip';
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
  /** CHAT-062: where the sound goes, and what else it could. */
  audio: AudioSnapshot;
  chooseAudioRoute: (route: AudioRoute) => void;
  /** CHAT-062: the app is shown in the small picture-in-picture window (Android). */
  isInPip: boolean;
  /** Shrinks the call into picture-in-picture (Android, video calls). */
  enterPip: (() => void) | null;
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

  // CHAT-061: the phone's own call screen (lock screen, CallKit / Telecom) and the engine in step.
  const [bridge] = useState(
    () =>
      new CallBridge({
        api: nativeCallApi,
        engine,
        waitForSignalling: () => waitForRealtime(SIGNALLING_WAIT_MS),
        now: () => Date.now(),
      }),
  );
  useEffect(() => bridge.onSnapshot(call), [bridge, call]);

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

  // CHAT-062 audio routing: the platform audio manager runs from connecting until the call ends.
  const [audioSession] = useState(() => new AudioSession(nativeAudioDriver));
  const audio = useSyncExternalStore(audioSession.subscribe, audioSession.getSnapshot);
  const liveAudio = hasLiveAudio(call);
  const videoCall = call !== null && isVideoCall(call);
  const kindRef = useRef<CallMedia>('audio');
  useEffect(() => {
    kindRef.current = videoCall ? 'video' : 'audio';
  }, [videoCall]);
  useEffect(() => {
    if (!liveAudio) return;
    let cancelled = false;
    void requestBluetoothPermission().then(() => {
      if (!cancelled) audioSession.begin(kindRef.current);
    });
    return () => {
      cancelled = true;
      audioSession.end();
    };
  }, [liveAudio, audioSession]);
  useEffect(() => {
    audioSession.setMedia(videoCall ? 'video' : 'audio');
  }, [videoCall, audioSession]);
  // CHAT-083: screen off against the ear on an earpiece audio call.
  const [proximity] = useState(() => new ProximityGuard(proximityScreen));
  useEffect(() => proximity.sync(audio), [proximity, audio]);
  useEffect(() => () => proximity.release(), [proximity]);

  // CHAT-062 picture-in-picture: a connected video call shrinks into a window when the app is
  // left (Android; iOS does the same through the video view itself).
  const inPip = useIsInPip();
  const inPipRef = useRef(false);
  useEffect(() => {
    inPipRef.current = inPip;
  }, [inPip]);
  const wantsPip = wantsPictureInPicture(call);
  useEffect(() => {
    if (!wantsPip) return;
    pip.setAutoEnter(true);
    return () => pip.setAutoEnter(false);
  }, [wantsPip]);

  // CHAT-062: out of sight and not in the small window means nobody sees the camera: switch it
  // off until the app is back (the other side sees "camera off" meanwhile).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      clearTimeout(timer);
      if (next === 'active') {
        engine.setVideoPaused(false);
      } else if (next === 'background') {
        timer = setTimeout(() => {
          if (!inPipRef.current) engine.setVideoPaused(true);
        }, BACKGROUND_PAUSE_DELAY_MS);
      }
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [engine]);

  // The realtime provider keeps the socket open in the background while this is true.
  const busy = call !== null && call.phase !== 'ended';
  useEffect(() => {
    setCallActive(busy);
    return () => setCallActive(false);
  }, [busy]);
  // CHAT-084: the next call starts from the Settings blur choice again.
  useEffect(() => {
    if (!busy) blur.callEnded();
  }, [busy]);

  // Once signed in, listen to the system call screen (and pick up a call it is already ringing
  // for -- the app may have been started by it).
  useEffect(() => {
    if (state.status !== 'signedIn') return;
    void bridge.start();
    return () => bridge.stop();
  }, [bridge, state.status]);

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
        const { stream, cameraMissing } = await acquireMedia(media, kind, {
          noiseSuppression: noiseSuppressionOn(),
        });
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

  /** Gets the microphone (and camera) and answers; false if that was not possible. */
  const answerNow = useCallback(
    async (kind: CallMedia): Promise<boolean> => {
      try {
        const { stream, cameraMissing } = await acquireMedia(media, kind, {
          noiseSuppression: noiseSuppressionOn(),
        });
        await engine.accept(stream as RtcStream);
        if (cameraMissing) explainCameraOff();
        return true;
      } catch (error) {
        // Could not get the microphone. Answered in the app's own screen (no system call) the call
        // stays ringing so it can still be declined; answered through the system, the bridge
        // declines it, as the system has already been told it was answered.
        explainMediaProblem(error);
        return false;
      }
    },
    [engine, media],
  );
  useEffect(() => bridge.setAnswerer(answerNow), [bridge, answerNow]);

  const accept = useCallback(
    async (kind: CallMedia) => {
      // Through the system when it has this call (it then needs to know it was answered).
      if (bridge.requestAnswer(kind)) return;
      await answerNow(kind);
    },
    [bridge, answerNow],
  );

  const value = useMemo<CallController>(
    () => ({
      call,
      endedText,
      startCall,
      accept,
      decline: () => {
        bridge.noteLocalEnd();
        engine.decline();
      },
      hangUp: () => {
        bridge.noteLocalEnd();
        engine.hangUp();
      },
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
      audio,
      chooseAudioRoute: (route) => audioSession.choose(route),
      isInPip: inPip,
      enterPip: wantsPip && pip.isAvailable() ? () => pip.enter() : null,
    }),
    [call, endedText, startCall, accept, engine, bridge, audio, audioSession, inPip, wantsPip],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

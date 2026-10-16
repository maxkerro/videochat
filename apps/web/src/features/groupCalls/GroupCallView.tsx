import '@livekit/components-styles';
import {
  CarouselLayout,
  ControlBar,
  FocusLayout,
  FocusLayoutContainer,
  GridLayout,
  isTrackReference,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useLocalParticipant,
  useParticipants,
  useTracks,
} from '@livekit/components-react';
import { BackgroundProcessor } from '@livekit/track-processors';
import {
  DisconnectReason,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type RoomOptions,
} from 'livekit-client';
import { useEffect, useMemo, useState } from 'react';
import {
  BLUR_ASSETS,
  BLUR_MAX_FPS,
  canBlurBackground,
  SlowBlurDetector,
} from '../calls/effects/backgroundBlur';
import { loadDevicePreferences, saveDevicePreferences } from '../calls/mediaDevices';
import { useCalls } from '../calls/CallProvider';
import { useToast } from '../../components/ui';
import type { GroupCallSession } from './GroupCallProvider';
import styles from './GroupCalls.module.css';

/**
 * Adaptive quality for up to 20 people: every camera is sent in several sizes (simulcast), each
 * viewer receives only the size its tile needs (adaptive stream), and layers nobody watches are
 * not sent at all (dynacast).
 */
/** Desktop browsers can share a screen; phones' browsers can't. */
function canShareScreen(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);
}

export const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  videoCaptureDefaults: { resolution: VideoPresets.h540.resolution },
  publishDefaults: {
    simulcast: true,
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    red: true,
    // Shared screens stay sharp (text) rather than smooth.
    screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
  },
};

/** CHAT-075: a background-blur processor for a LiveKit camera track, which `onSlow` reports
 *  (and which then gets turned off) if this device can't keep up. */
function blurProcessor(onSlow: () => void) {
  const detector = new SlowBlurDetector(onSlow);
  let total = 0;
  let frames = 0;
  let windowStart = performance.now();
  return BackgroundProcessor({
    mode: 'background-blur',
    blurRadius: 12,
    maxFps: BLUR_MAX_FPS,
    assetPaths: BLUR_ASSETS,
    onFrameProcessed: (stats) => {
      total += stats.processingTimeMs;
      frames += 1;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        detector.report({ frameMs: total / frames });
        total = 0;
        frames = 0;
        windowStart = now;
      }
    },
  });
}

/** Room options for this join: the remembered blur and noise-suppression choices (CHAT-075). A
 *  camera turned on with blur chosen is blurred from its first frame. */
function roomOptions(blur: boolean, noiseSuppression: boolean, onSlow: () => void): RoomOptions {
  return {
    ...ROOM_OPTIONS,
    videoCaptureDefaults: {
      ...ROOM_OPTIONS.videoCaptureDefaults,
      ...(blur ? { processor: blurProcessor(onSlow) } : {}),
    },
    audioCaptureDefaults: { echoCancellation: true, autoGainControl: true, noiseSuppression },
  };
}

/** CHAT-075: blur and noise-suppression switches during a group call. */
function Effects({
  blur,
  setBlur,
  onSlow,
}: {
  blur: boolean;
  setBlur: (on: boolean) => void;
  onSlow: () => void;
}) {
  const { toast } = useToast();
  const { cameraTrack, microphoneTrack } = useLocalParticipant();
  const camera = cameraTrack?.track as LocalVideoTrack | undefined;
  const microphone = microphoneTrack?.track as LocalAudioTrack | undefined;
  const [noise, setNoise] = useState(() => loadDevicePreferences().noiseSuppression ?? true);
  const supported = canBlurBackground();

  // Keep the camera's processor in step with the switch (the camera may come and go).
  useEffect(() => {
    if (!camera || !supported) return;
    const has = !!camera.getProcessor();
    if (blur && !has) {
      camera.setProcessor(blurProcessor(onSlow)).catch(() => {
        toast({ title: 'Background blur isn’t available right now.', tone: 'danger' });
        setBlur(false);
      });
    } else if (!blur && has) {
      void camera.stopProcessor();
    }
  }, [camera, blur, supported, onSlow, setBlur, toast]);

  return (
    <div className={styles.effects}>
      {supported && (
        <button
          type="button"
          className="lk-button"
          aria-pressed={blur}
          onClick={() => {
            saveDevicePreferences({ ...loadDevicePreferences(), backgroundBlur: !blur });
            setBlur(!blur);
          }}
        >
          {blur ? 'Unblur background' : 'Blur background'}
        </button>
      )}
      <button
        type="button"
        className="lk-button"
        aria-pressed={noise}
        disabled={!microphone}
        onClick={() => {
          const next = !noise;
          const deviceId = microphone?.mediaStreamTrack.getSettings().deviceId;
          microphone
            ?.restartTrack({
              ...(deviceId ? { deviceId } : {}),
              echoCancellation: true,
              autoGainControl: true,
              noiseSuppression: next,
            })
            .then(() => {
              setNoise(next);
              saveDevicePreferences({ ...loadDevicePreferences(), noiseSuppression: next });
            })
            .catch(() => toast({ title: 'Couldn’t change the microphone', tone: 'danger' }));
        }}
      >
        {noise ? 'Noise filter on' : 'Noise filter off'}
      </button>
    </div>
  );
}

function Stage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // CHAT-071: a shared screen takes the main stage; the cameras move to a strip beside it.
  const screen = tracks.find(
    (t) => isTrackReference(t) && t.publication.source === Track.Source.ScreenShare,
  );
  if (screen) {
    return (
      <FocusLayoutContainer className={styles.grid}>
        <CarouselLayout tracks={tracks.filter((t) => t !== screen)}>
          <ParticipantTile />
        </CarouselLayout>
        <FocusLayout trackRef={screen} />
      </FocusLayoutContainer>
    );
  }
  return (
    <GridLayout tracks={tracks} className={styles.grid}>
      {/* Speaking participants get `data-lk-speaking`, which the stylesheet outlines. */}
      <ParticipantTile />
    </GridLayout>
  );
}

function Header({
  title,
  minimised,
  onToggle,
}: {
  title: string;
  minimised: boolean;
  onToggle: () => void;
}) {
  const count = useParticipants().length;
  return (
    <div className={styles.header}>
      <div className={styles.headerText}>
        <strong>{title}</strong>
        <span>
          {count} {count === 1 ? 'person' : 'people'}
        </span>
      </div>
      <button type="button" className={styles.headerButton} onClick={onToggle}>
        {minimised ? 'Back to call' : 'Minimise'}
      </button>
    </div>
  );
}

/**
 * CHAT-070: the group call screen (LiveKit). Joins with the microphone on and the camera off --
 * people turn the camera on themselves, which also keeps a 20-person call light on CPU.
 * Minimised, the room stays connected and only a bar is shown, so the chat can be used.
 */
export default function GroupCallView({
  session,
  onLeave,
}: {
  session: GroupCallSession;
  onLeave: () => void;
}) {
  const { toast } = useToast();
  const [minimised, setMinimised] = useState(false);
  // CHAT-075: the remembered choices when joining; blur can be switched during the call.
  const [joinPrefs] = useState(() => loadDevicePreferences());
  const [blur, setBlur] = useState(() => !!joinPrefs.backgroundBlur && canBlurBackground());
  const [onSlow] = useState(() => () => {
    setBlur(false);
    toast({ title: 'Background blur was turned off: it was slowing this device down.' });
  });
  const options = useMemo(
    () => roomOptions(blur, joinPrefs.noiseSuppression ?? true, onSlow),
    // Only the choice at joining matters to the room; later switches act on the track directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Answering a 1:1 call that came in meanwhile leaves the group call (one call at a time).
  const oneToOne = useCalls().call;
  const answered = oneToOne !== null && oneToOne.phase !== 'incoming' && oneToOne.phase !== 'ended';
  useEffect(() => {
    if (answered) onLeave();
  }, [answered, onLeave]);
  return (
    <LiveKitRoom
      serverUrl={session.url}
      token={session.token}
      connect
      audio
      video={false}
      options={options}
      onDisconnected={(reason) => {
        // Left the group (or was removed from it): the server took them out of the call.
        if (reason === DisconnectReason.PARTICIPANT_REMOVED)
          toast({ title: 'You’re no longer in this group, so you left its call' });
        onLeave();
      }}
      onError={() => {
        toast({ title: 'The group call was interrupted', tone: 'danger' });
        onLeave();
      }}
      onMediaDeviceFailure={() =>
        toast({
          title: 'Can’t use your microphone or camera',
          description: 'Allow access in the browser’s site settings, then try again.',
          tone: 'danger',
        })
      }
      data-lk-theme="default"
      className={minimised ? styles.minimised : styles.screen}
      aria-label={`Group call in ${session.title}`}
    >
      <Header
        title={session.title}
        minimised={minimised}
        onToggle={() => setMinimised((m) => !m)}
      />
      {!minimised && <Stage />}
      {!minimised && <Effects blur={blur} setBlur={setBlur} onSlow={onSlow} />}
      <ControlBar
        variation={minimised ? 'minimal' : 'verbose'}
        controls={{
          chat: false,
          // CHAT-071: where the browser can share a screen.
          screenShare: canShareScreen(),
          settings: false,
        }}
      />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

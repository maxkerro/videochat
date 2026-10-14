import '@livekit/components-styles';
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useParticipants,
  useTracks,
} from '@livekit/components-react';
import { DisconnectReason, Track, VideoPresets, type RoomOptions } from 'livekit-client';
import { useEffect, useState } from 'react';
import { useCalls } from '../calls/CallProvider';
import { useToast } from '../../components/ui';
import type { GroupCallSession } from './GroupCallProvider';
import styles from './GroupCalls.module.css';

/**
 * Adaptive quality for up to 20 people: every camera is sent in several sizes (simulcast), each
 * viewer receives only the size its tile needs (adaptive stream), and layers nobody watches are
 * not sent at all (dynacast).
 */
export const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  videoCaptureDefaults: { resolution: VideoPresets.h540.resolution },
  publishDefaults: {
    simulcast: true,
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    red: true,
  },
};

function Stage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
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
      options={ROOM_OPTIONS}
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
      <ControlBar
        variation={minimised ? 'minimal' : 'verbose'}
        controls={{ chat: false, screenShare: false, settings: false }}
      />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

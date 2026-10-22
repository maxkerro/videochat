import { noiseSuppressionOn } from '../calls/callPrefs';
import {
  AndroidAudioTypePresets,
  AudioSession,
  isTrackReference,
  LiveKitRoom,
  setupIOSAudioManagement,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/react-native';
import {
  createLocalVideoTrack,
  DisconnectReason,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type RoomOptions,
} from 'livekit-client';
import { BLUR_SLOW_NOTICE, type EffectTrack } from '../calls/blur';
import { blur, useBlur } from '../calls/nativeBlur';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCalls } from '../calls/CallProvider';
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { groupCallParticipantsText } from '@videochat/shared';
import type { GroupCallSession } from './GroupCallProvider';
import { gridColumns, initialsOf, tileSize } from './layout';

const ACCENT = '#2cc3ad';

/** Simulcast for every camera, and each viewer receives only the size its tile needs. */
const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: { pixelDensity: 'screen' },
  dynacast: true,
  publishDefaults: { simulcast: true },
};

/** The phone's audio for the length of the group call: the loudspeaker unless a headset or
 *  Bluetooth device is connected. Not torn down when the call ends because a 1:1 call was
 *  answered (`handedOver`): that call's own audio session is starting at that moment. */
function useCallAudio(isHandedOver: () => boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let cleanupIos: (() => void) | undefined;
    void (async () => {
      try {
        if (Platform.OS === 'ios') cleanupIos = setupIOSAudioManagement(true);
        else
          await AudioSession.configureAudio({
            android: {
              preferredOutputList: ['bluetooth', 'headset', 'speaker'],
              audioTypeOptions: AndroidAudioTypePresets.communication,
            },
          });
        await AudioSession.startAudioSession();
      } catch {
        // The call still connects; the platform's default audio routing applies.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      cleanupIos?.();
      if (!isHandedOver()) void AudioSession.stopAudioSession().catch(() => undefined);
    };
  }, [isHandedOver]);
  return ready;
}

function Tile({
  trackRef,
  width,
  height,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  width: number;
  height: number;
}) {
  const participant = trackRef.participant;
  const speaking = useIsSpeaking(participant);
  const name = participant.name || participant.identity;
  const showVideo = isTrackReference(trackRef) && !trackRef.publication.isMuted;
  return (
    <View
      accessible
      accessibilityLabel={`${name}${speaking ? ', speaking' : ''}${participant.isLocal ? ' (you)' : ''}`}
      style={[styles.tile, { width, height, borderColor: speaking ? ACCENT : 'transparent' }]}
    >
      {showVideo ? (
        <VideoTrack trackRef={trackRef} style={StyleSheet.absoluteFill} objectFit="cover" />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.initials}>{initialsOf(name)}</Text>
        </View>
      )}
      <Text numberOfLines={1} style={styles.name}>
        {participant.isLocal ? `${name} (you)` : name}
      </Text>
    </View>
  );
}

function cameraTrack(
  localParticipant: ReturnType<typeof useLocalParticipant>['localParticipant'],
): LocalVideoTrack | undefined {
  return localParticipant.getTrackPublication(Track.Source.Camera)?.track as
    LocalVideoTrack | undefined;
}

function Controls({ onLeave }: { onLeave: () => void }) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const blurState = useBlur();
  const [front, setFront] = useState(true);
  const toggle = async (what: 'mic' | 'camera') => {
    try {
      if (what === 'mic') await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
      else if (!blurState.available) await localParticipant.setCameraEnabled(!isCameraEnabled);
      else if (isCameraEnabled) {
        // CHAT-084: off means stopped and unpublished, so turning it on again opens a fresh
        // camera that is blurred before it is published (unmuting would restart the camera
        // inside LiveKit and send a few frames before the blur is back on).
        const track = cameraTrack(localParticipant);
        if (track) await localParticipant.unpublishTrack(track, true);
      } else {
        const track = await createLocalVideoTrack({ facingMode: front ? 'user' : 'environment' });
        blur.attach(track.mediaStreamTrack as unknown as EffectTrack);
        await localParticipant.publishTrack(track, { source: Track.Source.Camera });
      }
    } catch {
      Alert.alert(
        'Can’t use your microphone or camera',
        'Allow access for this app in the phone’s settings, then try again.',
      );
    }
  };
  const flip = async () => {
    const track = cameraTrack(localParticipant);
    if (!track) return;
    const media = track.mediaStreamTrack as unknown as { _switchCamera?: () => void };
    // Same camera track, other lens: its blur stays on.
    if (media._switchCamera) media._switchCamera();
    else await track.restartTrack({ facingMode: front ? 'environment' : 'user' });
    setFront(!front);
  };
  return (
    <View style={styles.controls}>
      <ControlButton
        label={isMicrophoneEnabled ? 'Mute' : 'Unmute'}
        glyph={isMicrophoneEnabled ? '🎙' : '🔇'}
        onPress={() => void toggle('mic')}
      />
      <ControlButton
        label={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
        glyph={isCameraEnabled ? '📹' : '📷'}
        onPress={() => void toggle('camera')}
      />
      {isCameraEnabled ? (
        <ControlButton label="Switch camera" glyph="🔄" onPress={() => void flip()} />
      ) : null}
      {isCameraEnabled && blurState.available ? (
        <ControlButton
          label={blurState.on ? 'Turn off background blur' : 'Blur background'}
          glyph="◐"
          selected={blurState.on}
          onPress={() => blur.setOn(!blurState.on)}
        />
      ) : null}
      <ControlButton label="Leave call" glyph="✕" danger onPress={onLeave} />
    </View>
  );
}

/** CHAT-084: every camera this phone publishes goes through the blur, including one LiveKit
 *  restarts by itself (after which the blur is put back on the new track). */
function useCameraBlur(room: ReturnType<typeof useRoomContext>) {
  useEffect(() => {
    const handlers = new Map<LocalVideoTrack, () => void>();
    const onPublished = (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.Camera || !publication.track) return;
      const track = publication.track as LocalVideoTrack;
      const attach = () => blur.attach(track.mediaStreamTrack as unknown as EffectTrack);
      attach();
      if (handlers.has(track)) return;
      handlers.set(track, attach);
      track.on(TrackEvent.Restarted, attach);
    };
    room.on(RoomEvent.LocalTrackPublished, onPublished);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, onPublished);
      for (const [track, handler] of handlers) track.off(TrackEvent.Restarted, handler);
      blur.callEnded();
    };
  }, [room]);
}

function ControlButton({
  label,
  glyph,
  onPress,
  danger = false,
  selected,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  danger?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? {} : { selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        {
          backgroundColor: danger ? '#d64545' : selected ? ACCENT : '#2a2f36',
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text style={styles.controlGlyph}>{glyph}</Text>
    </Pressable>
  );
}

function RoomBody({
  session,
  minimised,
  setMinimised,
  onLeave,
}: {
  session: GroupCallSession;
  minimised: boolean;
  setMinimised: (m: boolean) => void;
  onLeave: () => void;
}) {
  useKeepAwake();
  const room = useRoomContext();
  useCameraBlur(room);
  const blurState = useBlur();
  useEffect(() => {
    const onGone = (reason?: DisconnectReason) => {
      // Left the group (or was removed from it): the server took them out of the call.
      if (reason === DisconnectReason.PARTICIPANT_REMOVED)
        Alert.alert('You left the call', 'You’re no longer in this group.');
    };
    room.on(RoomEvent.Disconnected, onGone);
    return () => {
      room.off(RoomEvent.Disconnected, onGone);
    };
  }, [room]);
  const count = useParticipants().length;
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  // CHAT-071: a screen someone shares (from the web) takes the main stage, above the tiles.
  const screens = useTracks([Track.Source.ScreenShare]).filter(isTrackReference);
  const screen = screens[0] ?? null;
  const { width, height } = useWindowDimensions();
  const size = tileSize(
    tracks.length,
    width,
    height - 200 - (screen ? Math.round(height * 0.45) : 0),
  );

  if (minimised) {
    return (
      <View style={styles.bar}>
        <Text style={styles.barText} numberOfLines={1}>
          {session.title} · {groupCallParticipantsText(count)}
        </Text>
        <Pressable accessibilityRole="button" onPress={() => setMinimised(false)}>
          <Text style={styles.link}>Back to call</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Leave call" onPress={onLeave}>
          <Text style={[styles.link, { color: '#ff8a8a' }]}>Leave</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1}>
            {session.title}
          </Text>
          <Text style={styles.subtitle}>{groupCallParticipantsText(count)}</Text>
          {blurState.turnedOffSlow ? (
            <Text style={styles.warning} accessibilityLiveRegion="polite">
              {BLUR_SLOW_NOTICE}
            </Text>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" onPress={() => setMinimised(true)}>
          <Text style={styles.link}>Minimise</Text>
        </Pressable>
      </View>
      {screen ? (
        <View
          accessible
          accessibilityLabel={`${screen.participant.name || 'Someone'} is sharing their screen`}
          style={{ height: Math.round(height * 0.45), backgroundColor: '#000' }}
        >
          <VideoTrack trackRef={screen} style={StyleSheet.absoluteFill} objectFit="contain" />
          <Text style={styles.name}>
            {screen.participant.name || screen.participant.identity}’s screen
          </Text>
        </View>
      ) : null}
      <FlatList
        key={gridColumns(tracks.length)}
        numColumns={gridColumns(tracks.length)}
        data={tracks}
        keyExtractor={(t) => `${t.participant.identity}:${t.source}`}
        renderItem={({ item }) => <Tile trackRef={item} width={size.width} height={size.height} />}
      />
      <Controls onLeave={onLeave} />
    </SafeAreaView>
  );
}

/**
 * CHAT-070: the group call screen. Joins with the microphone on and the camera off. Minimised, the
 * call goes on and only a bar is shown, so the chat can be used; the call stays connected while
 * the app is open (in the background Android may silence the microphone -- see docs/MOBILE.md).
 */
export function GroupCallScreen({
  session,
  onLeave,
}: {
  session: GroupCallSession;
  onLeave: () => void;
}) {
  // Answering a 1:1 call that came in meanwhile leaves the group call (one call at a time).
  const oneToOne = useCalls().call;
  const answered = oneToOne !== null && oneToOne.phase !== 'incoming' && oneToOne.phase !== 'ended';
  const handedOver = useRef(false);
  const isHandedOver = useCallback(() => handedOver.current, []);
  const audioReady = useCallAudio(isHandedOver);
  const [minimised, setMinimised] = useState(false);
  useEffect(() => {
    if (!answered) return;
    handedOver.current = true;
    onLeave();
  }, [answered, onLeave]);
  return (
    <View
      style={minimised ? styles.minimisedWrap : styles.screen}
      pointerEvents={minimised ? 'box-none' : 'auto'}
    >
      <LiveKitRoom
        serverUrl={session.url}
        token={session.token}
        connect={audioReady}
        audio
        video={false}
        options={{
          ...ROOM_OPTIONS,
          // CHAT-075: the noise-suppression setting, as the microphone is opened.
          audioCaptureDefaults: { noiseSuppression: noiseSuppressionOn() },
        }}
        onDisconnected={onLeave}
        onError={() => {
          Alert.alert('The group call was interrupted');
          onLeave();
        }}
      >
        <RoomBody
          session={session}
          minimised={minimised}
          setMinimised={setMinimised}
          onLeave={onLeave}
        />
      </LiveKitRoom>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { ...StyleSheet.absoluteFill, backgroundColor: '#0b0d10', zIndex: 20 },
  minimisedWrap: { position: 'absolute', left: 12, right: 12, bottom: 24, zIndex: 20 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  title: { color: '#fff', fontSize: 17, fontWeight: '600' },
  subtitle: { color: '#c9cdd2', fontSize: 13 },
  warning: { color: '#ffd166', fontSize: 13, marginTop: 2 },
  link: {
    color: ACCENT,
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tile: {
    backgroundColor: '#1a1e24',
    borderWidth: 3,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  placeholder: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontSize: 32, fontWeight: '700' },
  name: {
    color: '#fff',
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 12,
  },
  control: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlGlyph: { fontSize: 22, color: '#fff' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 14,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#0b0d10',
  },
  barText: { flex: 1, color: '#fff', fontSize: 14 },
});

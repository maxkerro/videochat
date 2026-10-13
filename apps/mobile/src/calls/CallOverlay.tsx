import { useEffect } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { SafeAreaView } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Avatar } from '../ui/Avatar';
import { useCalls } from './CallProvider';
import type { CallSnapshot } from './CallEngine';
import type { RtcStream } from './rtc';
import { useCallTimer } from './useCallTimer';

const KEEP_AWAKE_TAG = 'call';
const RING_PATTERN = [0, 900, 1_100];

function streamUrl(stream: RtcStream | null): string | null {
  return stream?.toURL?.() ?? null;
}

function statusLine(call: CallSnapshot, timer: string): string {
  switch (call.phase) {
    case 'outgoing':
      return call.calleeRinging ? 'Ringing…' : 'Calling…';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'active':
      return timer;
    default:
      return '';
  }
}

function CircleButton({
  label,
  glyph,
  onPress,
  tone = 'neutral',
  active = false,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  tone?: 'neutral' | 'danger' | 'ok';
  active?: boolean;
}) {
  const background =
    tone === 'danger' ? '#d93025' : tone === 'ok' ? '#1e9e4a' : active ? '#ffffff' : '#ffffff33';
  const color = tone === 'neutral' && active ? '#111111' : '#ffffff';
  return (
    <View style={styles.buttonWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={tone === 'neutral' ? { selected: active } : {}}
        onPress={onPress}
        style={({ pressed }) => [
          styles.circle,
          { backgroundColor: background, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.glyph, { color }]}>{glyph}</Text>
      </Pressable>
      <Text style={styles.buttonLabel}>{label}</Text>
    </View>
  );
}

function Incoming({ call }: { call: CallSnapshot }) {
  const calls = useCalls();
  // The app is in front and a call is ringing: buzz until it is answered or gone.
  useEffect(() => {
    Vibration.vibrate(RING_PATTERN, true);
    return () => Vibration.cancel();
  }, []);
  const video = call.media === 'video';
  return (
    <>
      <View style={styles.centre}>
        <Avatar name={call.peer.displayName} uri={call.peer.avatarUrl} size={120} />
        <Text style={styles.name}>{call.peer.displayName}</Text>
        <Text style={styles.status}>Incoming {video ? 'video' : 'audio'} call</Text>
      </View>
      <View style={styles.controls}>
        <CircleButton label="Decline" glyph="✕" tone="danger" onPress={calls.decline} />
        {video ? (
          <CircleButton label="Audio only" glyph="🎧" onPress={() => void calls.accept('audio')} />
        ) : null}
        <CircleButton
          label="Answer"
          glyph={video ? '▶' : '✆'}
          tone="ok"
          onPress={() => void calls.accept(call.media)}
        />
      </View>
    </>
  );
}

function InCall({ call }: { call: CallSnapshot }) {
  const calls = useCalls();
  const timer = useCallTimer(call.startedAt);
  const live = call.phase === 'active' || call.phase === 'reconnecting';
  const remoteUrl = streamUrl(call.remoteStream);
  const localUrl = streamUrl(call.localStream);
  const showRemoteVideo = live && remoteUrl !== null && call.remoteVideoEnabled;
  const showLocalVideo = call.videoEnabled && localUrl !== null;

  return (
    <>
      {showRemoteVideo ? (
        <RTCView
          streamURL={remoteUrl}
          objectFit="cover"
          style={StyleSheet.absoluteFill}
          zOrder={0}
        />
      ) : null}
      <View style={styles.top}>
        <Text style={styles.topName} numberOfLines={1}>
          {call.peer.displayName}
        </Text>
        <Text style={styles.topStatus} accessibilityLiveRegion="polite">
          {statusLine(call, timer)}
        </Text>
        {call.quality === 'poor' && call.phase === 'active' ? (
          <Text style={styles.warning}>Poor connection</Text>
        ) : null}
      </View>
      {!showRemoteVideo ? (
        <View style={styles.centre}>
          <Avatar name={call.peer.displayName} uri={call.peer.avatarUrl} size={120} />
          {live && call.media === 'video' && !call.remoteVideoEnabled ? (
            <Text style={styles.status}>{call.peer.displayName}’s camera is off</Text>
          ) : null}
        </View>
      ) : null}
      {!call.remoteAudioEnabled && live ? (
        <Text style={styles.muted}>{call.peer.displayName} is muted</Text>
      ) : null}
      {showLocalVideo ? (
        <View style={styles.selfView} pointerEvents="none">
          <RTCView
            streamURL={localUrl}
            objectFit="cover"
            mirror={call.frontCamera}
            style={styles.selfVideo}
            zOrder={1}
          />
        </View>
      ) : null}
      {call.lowBandwidth ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void calls.toggleVideo()}
          style={styles.suggestion}
        >
          <Text style={styles.suggestionText}>
            Slow connection. Tap to turn off your camera and keep the call going.
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.controls}>
        <CircleButton
          label={call.audioEnabled ? 'Mute' : 'Unmute'}
          glyph={call.audioEnabled ? '🎤' : '🔇'}
          active={!call.audioEnabled}
          onPress={calls.toggleAudio}
        />
        <CircleButton
          label={call.videoEnabled ? 'Camera off' : 'Camera on'}
          glyph="📷"
          active={!call.videoEnabled}
          onPress={() => void calls.toggleVideo()}
        />
        {call.videoEnabled ? (
          <CircleButton label="Flip" glyph="⟳" onPress={calls.switchCamera} />
        ) : null}
        <CircleButton label="End" glyph="✕" tone="danger" onPress={calls.hangUp} />
      </View>
    </>
  );
}

/**
 * CHAT-060: the call screen, drawn over whatever the app is showing. Ringing (incoming), calling
 * (outgoing), the live call, and a moment of "Call ended".
 */
export function CallOverlay() {
  const { call, endedText, hangUp } = useCalls();
  const visible = call !== null;
  const ongoing = call !== null && call.phase !== 'ended';

  // The call screen is modal: Android's back button must not drop the app behind a live call.
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [visible]);

  useEffect(() => {
    if (!ongoing) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [ongoing]);

  if (!call) return null;
  return (
    <SafeAreaView style={styles.root} accessibilityViewIsModal>
      {call.phase === 'incoming' ? (
        <Incoming call={call} />
      ) : call.phase === 'ended' ? (
        <View style={styles.centre}>
          <Avatar name={call.peer.displayName} uri={call.peer.avatarUrl} size={96} />
          <Text style={styles.name}>{call.peer.displayName}</Text>
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {endedText ?? 'Call ended'}
          </Text>
        </View>
      ) : call.phase === 'outgoing' || call.phase === 'connecting' ? (
        <>
          <View style={styles.centre}>
            <Avatar name={call.peer.displayName} uri={call.peer.avatarUrl} size={120} />
            <Text style={styles.name}>{call.peer.displayName}</Text>
            <Text style={styles.status} accessibilityLiveRegion="polite">
              {statusLine(call, '')}
            </Text>
          </View>
          <View style={styles.controls}>
            <CircleButton
              label={call.phase === 'outgoing' ? 'Cancel' : 'End'}
              glyph="✕"
              tone="danger"
              onPress={hangUp}
            />
          </View>
        </>
      ) : (
        <InCall call={call} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#111314',
    justifyContent: 'space-between',
    zIndex: 1000,
    elevation: 1000,
  },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  name: { color: '#ffffff', fontSize: 26, fontWeight: '700' },
  status: { color: '#ffffffcc', fontSize: 16 },
  top: { alignItems: 'center', paddingTop: 12, gap: 2 },
  topName: { color: '#ffffff', fontSize: 20, fontWeight: '700', maxWidth: '80%' },
  topStatus: { color: '#ffffffcc', fontSize: 15 },
  warning: { color: '#ffb74d', fontSize: 13, fontWeight: '600' },
  muted: { color: '#ffffffcc', textAlign: 'center', paddingBottom: 8 },
  selfView: {
    position: 'absolute',
    top: 72,
    right: 16,
    width: 96,
    height: 136,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  selfVideo: { flex: 1 },
  suggestion: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#000000aa',
  },
  suggestionText: { color: '#ffffff', textAlign: 'center' },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'flex-start',
    paddingBottom: 24,
    paddingTop: 12,
  },
  buttonWrap: { alignItems: 'center', gap: 6, minWidth: 72 },
  circle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 26 },
  buttonLabel: { color: '#ffffffcc', fontSize: 12 },
});

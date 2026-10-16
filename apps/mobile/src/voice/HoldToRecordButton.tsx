import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useEffect, useState } from 'react';
import { Alert, PanResponder, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../ui/theme';
import { VoiceCapture } from './capture';
import { expoRecorder, VOICE_RECORDING } from './expoAudio';
import { HoldToRecord, type HoldHandlers } from './holdSession';

export type { RecordingState } from './holdSession';

async function ensurePermission(): Promise<boolean> {
  const permission = await getRecordingPermissionsAsync();
  if (permission.granted) return true;
  const asked = permission.canAskAgain ? await requestRecordingPermissionsAsync() : permission;
  if (!asked.granted) {
    Alert.alert(
      'Microphone access is off',
      'Allow Chat to use the microphone in your phone’s settings to send voice messages.',
    );
  }
  return false;
}

/** CHAT-074: the microphone button (see {@link HoldToRecord}). */
export function HoldToRecordButton(props: HoldHandlers) {
  const t = useTheme();
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const [active, setActive] = useState(false);
  // The button turns red while recording, however the recording ends (let go, the 5-minute limit).
  const handlers = (): HoldHandlers => ({
    ...props,
    onState: (state) => {
      setActive(state.recording);
      props.onState(state);
    },
  });
  const [{ hold, responder }] = useState(() => {
    const session = new HoldToRecord(
      new VoiceCapture(expoRecorder(recorder)),
      {
        ensurePermission,
        alert: (title, message) => Alert.alert(title, message),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      },
      handlers(),
    );
    return {
      hold: session,
      responder: PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => void session.begin(),
        onPanResponderMove: (_e, g) => session.move(g.dx),
        onPanResponderRelease: () => void session.release(),
        onPanResponderTerminate: () => void session.end(false),
        onPanResponderTerminationRequest: () => false,
      }),
    };
  });
  useEffect(() => {
    hold.update(handlers());
  });
  // Leaving the chat throws away an unfinished recording.
  useEffect(() => () => void hold.end(false), [hold]);

  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={active ? 'Send voice message' : 'Record voice message'}
      accessibilityHint={
        active ? undefined : 'Hold to record, release to send, slide left to cancel'
      }
      accessibilityActions={[{ name: 'activate' }, ...(active ? [{ name: 'escape' }] : [])]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'escape') void hold.end(false);
        else if (hold.active) void hold.end(true);
        else void hold.begin();
      }}
      style={[styles.mic, { backgroundColor: active ? t.error : t.accent }]}
    >
      <Text style={{ color: t.accentText, fontSize: 18 }}>🎤</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mic: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});

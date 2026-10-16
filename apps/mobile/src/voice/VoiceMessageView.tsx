import {
  formatVoiceTime,
  nextVoiceSpeed,
  type Attachment,
  type VoiceInfo,
} from '@videochat/shared';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../ui/theme';
import { useVoicePlayback, voicePlayback } from './index';

/** The bars of a waveform; those before `progress` (0..1) are drawn as played. */
export function WaveformBars({
  waveform,
  progress,
  color,
}: {
  waveform: number[];
  progress: number;
  color: string;
}) {
  return (
    <View style={styles.bars} pointerEvents="none">
      {waveform.map((v, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: `${Math.max(10, v)}%`,
              backgroundColor: color,
              opacity: (i + 0.5) / waveform.length <= progress ? 1 : 0.35,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** CHAT-074: a voice message in the chat: play/pause, tap the waveform to seek, 1x/1.5x/2x. */
export function VoiceMessageView({
  attachment,
  mine,
  title,
}: {
  attachment: Attachment & { voice: VoiceInfo };
  mine: boolean;
  /** Shown on the lock screen while it plays ("Voice message from Ben"). */
  title: string;
}) {
  const t = useTheme();
  const state = useVoicePlayback();
  const [width, setWidth] = useState(0);
  const { durationMs, waveform } = attachment.voice;
  const current = state.attachmentId === attachment.id;
  const playing = current && state.playing;
  const position = current ? Math.min(state.positionMs, durationMs) : 0;
  const color = mine ? t.accentText : t.accent;
  const text = mine ? t.accentText : t.text;
  const seekBy = (ms: number) =>
    void voicePlayback.seek(attachment.id, Math.max(0, Math.min(durationMs, position + ms)));

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
        onPress={() => void voicePlayback.toggle(attachment.id, title)}
        style={[styles.play, { backgroundColor: color }]}
        hitSlop={6}
      >
        {current && state.loading ? (
          <ActivityIndicator color={mine ? t.accent : t.accentText} />
        ) : (
          <Text style={{ color: mine ? t.accent : t.accentText, fontSize: 16, fontWeight: '700' }}>
            {playing ? '❚❚' : '▶'}
          </Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="adjustable"
        accessibilityLabel="Voice message position"
        accessibilityValue={{
          text: `${formatVoiceTime(position)} of ${formatVoiceTime(durationMs)}`,
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) =>
          seekBy(e.nativeEvent.actionName === 'increment' ? 5000 : -5000)
        }
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onPress={(e) => {
          if (width > 0) {
            void voicePlayback.seek(
              attachment.id,
              Math.round((e.nativeEvent.locationX / width) * durationMs),
            );
          }
        }}
        style={styles.seek}
      >
        <WaveformBars
          waveform={waveform}
          progress={durationMs ? position / durationMs : 0}
          color={color}
        />
      </Pressable>
      <Text style={[styles.time, { color: text }]}>
        {current && (state.playing || position > 0)
          ? formatVoiceTime(position)
          : formatVoiceTime(durationMs)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Playback speed ${state.rate}x`}
        onPress={() => voicePlayback.setRate(nextVoiceSpeed(state.rate))}
        style={[styles.speed, { borderColor: color }]}
        hitSlop={6}
      >
        <Text style={{ color: text, fontSize: 12, fontWeight: '700' }}>{state.rate}x</Text>
      </Pressable>
      {current && state.error ? (
        <Text style={{ color: t.error, fontSize: 12 }}>Couldn’t play</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 220, flexWrap: 'wrap' },
  play: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  seek: { flex: 1, minWidth: 110, height: 30, justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 2, height: '100%' },
  bar: { flex: 1, minWidth: 2, borderRadius: 1 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'], minWidth: 34 },
  speed: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 },
});

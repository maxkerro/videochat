import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes } from '../ui/format';
import { useTheme } from '../ui/theme';
import type { UploadEntry } from '../uploads/manager';

/** The words under a file that is on its way. */
export function uploadStatusText(entry: UploadEntry): string {
  if (entry.status === 'failed') return `Not sent${entry.error ? `: ${entry.error}` : ''}`;
  if (entry.retrying) return 'Connection problem, trying again…';
  if (entry.phase === 'preparing') return 'Preparing…';
  if (entry.phase === 'sending') return 'Sending…';
  return `Uploading ${Math.round(entry.progress * 100)}%`;
}

/** CHAT-056: a photo or file being sent, with its progress, shown where the message will appear. */
export function UploadBubble({
  entry,
  onRetry,
  onDiscard,
}: {
  entry: UploadEntry;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useTheme();
  const failed = entry.status === 'failed';
  const isImage = entry.file.contentType.startsWith('image/');
  const text = uploadStatusText(entry);
  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityLabel={`${entry.file.name}. ${text}`}
        accessibilityLiveRegion="polite"
        style={[styles.bubble, { backgroundColor: t.accent, opacity: failed ? 1 : 0.8 }]}
      >
        {isImage ? (
          <Image source={{ uri: entry.file.uri }} style={styles.thumb} resizeMode="cover" />
        ) : (
          <Text numberOfLines={1} style={{ color: t.accentText, fontWeight: '600' }}>
            {entry.file.name}
            {entry.file.sizeBytes ? ` · ${formatBytes(entry.file.sizeBytes)}` : ''}
          </Text>
        )}
        {!failed ? (
          <View style={[styles.track, { backgroundColor: '#ffffff55' }]}>
            <View
              style={[
                styles.fill,
                {
                  backgroundColor: t.accentText,
                  width: `${Math.round((entry.phase === 'uploading' ? entry.progress : 1) * 100)}%`,
                },
              ]}
            />
          </View>
        ) : null}
      </View>
      <Text style={{ color: failed ? t.error : t.muted, fontSize: 12 }}>{text}</Text>
      <View style={styles.actions}>
        {failed ? (
          <Pressable accessibilityRole="button" onPress={onRetry}>
            <Text style={{ color: t.accent, fontWeight: '600' }}>Retry</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onDiscard}>
          <Text style={{ color: t.error, fontWeight: '600' }}>{failed ? 'Delete' : 'Cancel'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    marginVertical: 2,
    maxWidth: '85%',
    gap: 2,
  },
  bubble: { borderRadius: 16, padding: 6, gap: 6, maxWidth: 232 },
  thumb: { width: 220, height: 160, borderRadius: 10 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4 },
  actions: { flexDirection: 'row', gap: 16 },
});

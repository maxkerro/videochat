import { useQuery } from '@tanstack/react-query';
import type { Attachment } from '@videochat/shared';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { fetchAttachmentUrl } from '../data/api';
import { formatBytes } from '../ui/format';
import { useTheme } from '../ui/theme';

/** Signed URLs live a few minutes; refetch before they run out rather than showing a dead image. */
const URL_STALE_MS = 4 * 60_000;

async function openOriginal(attachmentId: string) {
  try {
    const { url } = await fetchAttachmentUrl(attachmentId, 'original');
    await Linking.openURL(url);
  } catch {
    Alert.alert('Couldn’t open the file', 'Check your connection and try again.');
  }
}

export function AttachmentView({ attachment }: { attachment: Attachment }) {
  const t = useTheme();
  const isImage = attachment.kind === 'image';
  const thumb = useQuery({
    queryKey: ['attachment-url', attachment.id, 'thumb'],
    queryFn: () => fetchAttachmentUrl(attachment.id, 'thumb'),
    enabled: isImage,
    staleTime: URL_STALE_MS,
  });

  if (isImage) {
    const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : 1;
    const width = 220;
    const height = Math.min(Math.max(width / ratio, 80), 320);
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Photo ${attachment.filename}. Open`}
        onPress={() => void openOriginal(attachment.id)}
        style={[styles.image, { width, height, backgroundColor: t.border }]}
      >
        {thumb.data ? (
          <Image source={{ uri: thumb.data.url }} style={{ width, height }} resizeMode="cover" />
        ) : thumb.isError ? (
          <Text style={[styles.imageNote, { color: t.muted }]}>Photo unavailable</Text>
        ) : (
          <ActivityIndicator />
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`File ${attachment.filename}, ${formatBytes(attachment.sizeBytes)}. Open`}
      onPress={() => void openOriginal(attachment.id)}
      style={[styles.file, { borderColor: t.border }]}
    >
      <Text style={[styles.fileName, { color: t.text }]} numberOfLines={1}>
        {attachment.filename}
      </Text>
      <View>
        <Text style={{ color: t.muted, fontSize: 12 }}>{formatBytes(attachment.sizeBytes)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  imageNote: { fontSize: 13 },
  file: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 2, minWidth: 180, maxWidth: 240 },
  fileName: { fontSize: 15, fontWeight: '600' },
});

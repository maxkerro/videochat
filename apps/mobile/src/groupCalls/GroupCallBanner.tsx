import { groupCallParticipantsText } from '@videochat/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../ui/theme';
import { useGroupCall } from './GroupCallProvider';
import { useRunningGroupCall } from './useRunningGroupCall';

/** CHAT-070: the header button that starts a group call (hidden while one is running). */
export function GroupCallButton({
  conversationId,
  title,
}: {
  conversationId: string;
  title: string;
}) {
  const t = useTheme();
  const groupCall = useGroupCall();
  const running = useRunningGroupCall(conversationId, true);
  if (running || groupCall.session?.conversationId === conversationId) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Start a group call"
      disabled={groupCall.joining !== null}
      onPress={() => void groupCall.join(conversationId, title)}
      hitSlop={4}
      style={({ pressed }) => [styles.headerButton, { opacity: pressed ? 0.5 : 1 }]}
    >
      <Text style={{ color: t.accent, fontSize: 22 }}>📹</Text>
    </Pressable>
  );
}

/** CHAT-070: "Group call · 3 people in the call · Join", under the header while one runs. */
export function GroupCallBanner({
  conversationId,
  title,
}: {
  conversationId: string;
  title: string;
}) {
  const t = useTheme();
  const groupCall = useGroupCall();
  const running = useRunningGroupCall(conversationId, true);
  if (!running) return null;
  const here = groupCall.session?.conversationId === conversationId;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: t.card, borderBottomColor: t.border }]}
    >
      <View style={styles.dot} />
      <Text style={[styles.text, { color: t.text }]} numberOfLines={1}>
        Group call · {groupCallParticipantsText(running.participantCount)}
      </Text>
      {here ? (
        <Text style={{ color: t.muted }}>You’re in it</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Join the group call"
          disabled={groupCall.joining !== null}
          onPress={() => void groupCall.join(conversationId, title)}
          style={[styles.join, { backgroundColor: t.accent }]}
        >
          <Text style={{ color: t.accentText, fontWeight: '600' }}>
            {groupCall.joining === conversationId ? 'Joining…' : 'Join'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerButton: { width: 44, height: 52, alignItems: 'center', justifyContent: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1fa155' },
  text: { flex: 1, fontSize: 14 },
  join: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 },
});

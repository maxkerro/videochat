import { Stack, useRouter } from 'expo-router';
import type { ConversationSummary } from '@videochat/shared';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../../src/auth/AuthContext';
import { useConversations } from '../../src/data/hooks';
import { useIsOnline } from '../../src/data/useLive';
import { Avatar } from '../../src/ui/Avatar';
import { Banner } from '../../src/ui/Banner';
import { describeError } from '../../src/ui/describeError';
import {
  conversationTitle,
  formatListTime,
  lastMessagePreview,
  unreadCount,
} from '../../src/ui/format';
import { useTheme } from '../../src/ui/theme';

function Row({
  c,
  myId,
  onOpen,
}: {
  c: ConversationSummary;
  myId: string;
  onOpen: (id: string) => void;
}) {
  const t = useTheme();
  const unread = unreadCount(c);
  const title = conversationTitle(c);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}${unread ? `, ${unread} unread` : ''}`}
      onPress={() => onOpen(c.id)}
      style={[styles.row, { borderBottomColor: t.border }]}
    >
      <Avatar name={title} uri={c.type === 'direct' ? c.peer?.avatarUrl : null} />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text numberOfLines={1} style={[styles.title, { color: t.text }]}>
            {title}
          </Text>
          <Text style={{ color: unread ? t.accent : t.muted, fontSize: 12 }}>
            {formatListTime(c.lastMessageAt)}
          </Text>
        </View>
        <View style={styles.line}>
          <Text numberOfLines={1} style={[styles.preview, { color: t.muted }]}>
            {c.muted ? '🔕 ' : ''}
            {lastMessagePreview(c, myId)}
          </Text>
          {unread ? (
            <View style={[styles.badge, { backgroundColor: c.muted ? t.muted : t.accent }]}>
              <Text style={{ color: t.accentText, fontSize: 12, fontWeight: '700' }}>
                {unread > 99 ? '99+' : unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export default function Inbox() {
  const t = useTheme();
  const router = useRouter();
  const { state } = useAuth();
  const myId = state.status === 'signedIn' ? state.user.id : '';
  const online = useIsOnline();
  const query = useConversations();
  const open = useCallback((id: string) => router.push(`/c/${id}`), [router]);

  return (
    <View style={[styles.flex, { backgroundColor: t.bg }]}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerButtons}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Search messages"
                onPress={() => router.push('/search')}
              >
                <Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>Search</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => router.push('/new')}>
                <Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>New</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => router.push('/profile')}>
                <Text style={{ color: t.accent, fontSize: 16, fontWeight: '600' }}>Me</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {!online ? <Banner>You’re offline. Showing saved chats.</Banner> : null}
      {query.data === undefined && query.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading chats" />
        </View>
      ) : query.data === undefined ? (
        <View style={styles.center}>
          <Text style={{ color: t.error, textAlign: 'center', padding: 24 }}>
            {describeError(query.error)}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => void query.refetch()}>
            <Text style={{ color: t.accent, fontWeight: '600' }}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={query.data}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <Row c={item} myId={myId} onOpen={open} />}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={t.accent}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={{ color: t.muted, textAlign: 'center', padding: 24 }}>
                No chats yet. Tap New to start one.
              </Text>
            </View>
          }
          contentContainerStyle={query.data.length === 0 ? styles.flex : undefined}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerButtons: { flexDirection: 'row', gap: 20, paddingRight: 4 },
  row: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  preview: { flex: 1, fontSize: 14 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

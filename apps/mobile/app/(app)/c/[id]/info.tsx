import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LIMITS, REPORT_REASONS, type ReportReason } from '@videochat/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../../../../src/auth/AuthContext';
import * as actions from '../../../../src/data/actions';
import {
  blockUser,
  fetchBlockedUsers,
  reportUser,
  searchUsers,
  unblockUser,
} from '../../../../src/data/api';
import { MessageActions } from '../../../../src/chat/MessageActions';
import { useConversation, useMembers } from '../../../../src/data/hooks';
import { keys } from '../../../../src/data/keys';
import { Avatar } from '../../../../src/ui/Avatar';
import { describeError } from '../../../../src/ui/describeError';
import { Button } from '../../../../src/ui/Form';
import { conversationTitle } from '../../../../src/ui/format';
import { useTheme } from '../../../../src/ui/theme';

function fail(title: string, e: unknown) {
  Alert.alert(title, describeError(e));
}

export default function ChatInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { state } = useAuth();
  const myId = state.status === 'signedIn' ? state.user.id : '';

  const conversation = useConversation(id);
  const c = conversation.data;
  const isGroup = c?.type === 'group';
  const isAdmin = c?.role === 'admin';
  const members = useMembers(id, isGroup);
  const blocked = useQuery({
    queryKey: keys.blocked,
    queryFn: fetchBlockedUsers,
    enabled: c?.type === 'direct',
  });

  const [title, setTitle] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const memberIds = new Set((members.data ?? []).map((m) => m.userId));
  const candidates = useQuery({
    queryKey: ['user-search', find.trim()],
    queryFn: () => searchUsers(find.trim()),
    enabled: isAdmin && find.trim().length > 0,
    staleTime: 30_000,
  });

  if (!c) return <View style={[styles.flex, { backgroundColor: t.bg }]} />;

  const name = conversationTitle(c);
  const peerBlocked = c.peer
    ? (blocked.data?.users.some((u) => u.id === c.peer?.id) ?? false)
    : false;

  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      fail(label, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Avatar name={name} uri={c.type === 'direct' ? c.peer?.avatarUrl : null} size={80} />
        <Text style={[styles.heading, { color: t.text }]}>{name}</Text>
        {c.peer ? <Text style={{ color: t.muted }}>@{c.peer.username}</Text> : null}
      </View>

      <View style={[styles.rowBetween, { borderColor: t.border }]}>
        <Text style={{ color: t.text, fontSize: 16 }}>Mute notifications</Text>
        <Switch
          accessibilityLabel="Mute notifications"
          value={c.muted}
          onValueChange={(muted) =>
            void run('Couldn’t change that', () => actions.setMuted(id, muted))
          }
        />
      </View>

      <Button
        title="Search in this chat"
        kind="link"
        onPress={() => router.push(`/search?in=${id}`)}
      />

      <Button
        title="Mark as unread"
        kind="link"
        onPress={() =>
          void run('Couldn’t mark as unread', async () => {
            await actions.markUnread(id);
            router.replace('/');
          })
        }
      />

      {isGroup && isAdmin ? (
        <View style={styles.section}>
          <Text style={[styles.label, { color: t.text }]}>Group name</Text>
          <TextInput
            accessibilityLabel="Group name"
            value={title ?? c.title ?? ''}
            onChangeText={setTitle}
            maxLength={LIMITS.groupTitleMax}
            style={[
              styles.input,
              { color: t.text, backgroundColor: t.card, borderColor: t.border },
            ]}
          />
          {title !== null && title.trim() && title.trim() !== c.title ? (
            <Button
              title="Save name"
              busy={busy}
              onPress={() =>
                void run('Couldn’t rename', async () => {
                  await actions.renameGroup(id, title.trim());
                  setTitle(null);
                })
              }
            />
          ) : null}
        </View>
      ) : null}

      {isGroup ? (
        <View style={styles.section}>
          <Text style={[styles.label, { color: t.text }]}>
            Members{members.data ? ` (${members.data.length})` : ''}
          </Text>
          {(members.data ?? []).map((m) => (
            <View key={m.userId} style={[styles.member, { borderBottomColor: t.border }]}>
              <Avatar name={m.displayName} uri={m.avatarUrl} size={36} />
              <View style={styles.flex}>
                <Text style={{ color: t.text, fontWeight: '600' }}>
                  {m.displayName}
                  {m.userId === myId ? ' (you)' : ''}
                </Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>
                  @{m.username}
                  {m.role === 'admin' ? ' · admin' : ''}
                </Text>
              </View>
              {isAdmin && m.userId !== myId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${m.displayName}`}
                  onPress={() =>
                    Alert.alert(`Remove ${m.displayName}?`, undefined, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () =>
                          void run('Couldn’t remove', () =>
                            actions.removeGroupMember(id, m.userId),
                          ),
                      },
                    ])
                  }
                >
                  <Text style={{ color: t.error, fontWeight: '600' }}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {isGroup && isAdmin ? (
        <View style={styles.section}>
          <Text style={[styles.label, { color: t.text }]}>Add people</Text>
          <TextInput
            accessibilityLabel="Find people by username or email"
            value={find}
            onChangeText={setFind}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Username or email"
            placeholderTextColor={t.muted}
            style={[
              styles.input,
              { color: t.text, backgroundColor: t.card, borderColor: t.border },
            ]}
          />
          {(candidates.data?.users ?? [])
            .filter((u) => !memberIds.has(u.id))
            .map((u) => (
              <Pressable
                key={u.id}
                accessibilityRole="button"
                accessibilityLabel={`Add ${u.displayName}`}
                onPress={() =>
                  void run('Couldn’t add', async () => {
                    await actions.addGroupMembers(id, [u.id]);
                    setFind('');
                  })
                }
                style={[styles.member, { borderBottomColor: t.border }]}
              >
                <Avatar name={u.displayName} uri={u.avatarUrl} size={36} />
                <View style={styles.flex}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{u.displayName}</Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>@{u.username}</Text>
                </View>
                <Text style={{ color: t.accent, fontWeight: '600' }}>Add</Text>
              </Pressable>
            ))}
        </View>
      ) : null}

      {c.peer ? (
        <Button
          title={peerBlocked ? `Unblock ${c.peer.displayName}` : `Block ${c.peer.displayName}`}
          kind="link"
          onPress={() => {
            const peer = c.peer;
            if (!peer) return;
            const toggle = () =>
              void run('Couldn’t change that', async () => {
                await (peerBlocked ? unblockUser(peer.id) : blockUser(peer.id));
                await queryClient.invalidateQueries({ queryKey: keys.blocked });
              });
            if (peerBlocked) toggle();
            else
              Alert.alert(`Block ${peer.displayName}?`, 'They won’t be able to message you.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Block', style: 'destructive', onPress: toggle },
              ]);
          }}
        />
      ) : null}

      {c.peer ? (
        <Button
          title={`Report ${c.peer.displayName}`}
          kind="link"
          onPress={() => setReportOpen(true)}
        />
      ) : null}
      <MessageActions
        message={null}
        open={reportOpen}
        title={c.peer ? `Report ${c.peer.displayName}` : 'Report'}
        actions={REPORT_REASONS.map((reason) => ({
          label: REPORT_LABELS[reason],
          onPress: () => {
            const peer = c.peer;
            if (!peer) return;
            void run('Couldn’t send the report', async () => {
              await reportUser(peer.id, { conversationId: id, reason });
              Alert.alert('Thanks for letting us know', 'Our moderators will review it.');
            });
          },
        }))}
        onClose={() => setReportOpen(false)}
      />

      {isGroup ? (
        <Button
          title="Leave group"
          kind="link"
          onPress={() =>
            Alert.alert('Leave this group?', undefined, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Leave',
                style: 'destructive',
                onPress: () =>
                  void run('Couldn’t leave', async () => {
                    await actions.leaveGroup(id);
                    router.replace('/');
                  }),
              },
            ])
          }
        />
      ) : null}
    </ScrollView>
  );
}

/** CHAT-077: same wording as reporting a message. */
const REPORT_LABELS: Record<ReportReason, string> = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  inappropriate: 'Inappropriate content',
  other: 'Something else',
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 16, gap: 16 },
  hero: { alignItems: 'center', gap: 6 },
  heading: { fontSize: 22, fontWeight: '700' },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  section: { gap: 8 },
  label: { fontSize: 14, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

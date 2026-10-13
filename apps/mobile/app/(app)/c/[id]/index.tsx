import type { Message } from '@videochat/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../../../src/auth/AuthContext';
import {
  pickFile,
  pickPhoto,
  sendAttachment,
  type PickedFile,
} from '../../../../src/chat/attachments';
import { Composer } from '../../../../src/chat/Composer';
import { MessageActions, type MessageAction } from '../../../../src/chat/MessageActions';
import { MessageBubble } from '../../../../src/chat/MessageBubble';
import { buildRows, type ChatRow } from '../../../../src/chat/rows';
import * as actions from '../../../../src/data/actions';
import { useConversation, useMembers, useMessages, useOutbox } from '../../../../src/data/hooks';
import {
  discardOutboxMessage,
  queueTextMessage,
  retryOutboxMessage,
} from '../../../../src/data/outboxRunner';
import { useAppActive, useIsOnline } from '../../../../src/data/useLive';
import { useTypingSender, useViewingReporter } from '../../../../src/realtime/hooks';
import { presenceLabel, usePresence } from '../../../../src/realtime/presence';
import { useTypingLabel } from '../../../../src/realtime/typing';
import { Banner } from '../../../../src/ui/Banner';
import { describeError } from '../../../../src/ui/describeError';
import { canDeleteMessage, canEditMessage, conversationTitle } from '../../../../src/ui/format';
import { useTheme } from '../../../../src/ui/theme';
import { useKeyboardVisible } from '../../../../src/ui/useKeyboardVisible';

function fail(title: string, e: unknown) {
  Alert.alert(title, describeError(e));
}

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const { state: auth } = useAuth();
  const myId = auth.status === 'signedIn' ? auth.user.id : '';

  const conversation = useConversation(id);
  const view = useMessages(id);
  const outbox = useOutbox(id);
  const isGroup = conversation.data?.type === 'group';
  const members = useMembers(id, isGroup);
  const online = useIsOnline();
  const appActive = useAppActive();
  useViewingReporter(id);
  const sendTyping = useTypingSender(id);
  const typing = useTypingLabel(id);
  const peerId = !isGroup ? (conversation.data?.peer?.id ?? null) : null;
  const presence = usePresence(peerId ? [peerId] : []);
  const subtitle = typing ?? (peerId ? presenceLabel(presence.get(peerId)) : null);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const names = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.userId, m.displayName])),
    [members.data],
  );

  const messages = view.state?.messages;
  const rows = useMemo(
    () =>
      buildRows({
        messages: messages ?? [],
        outbox,
        myId,
        isGroup,
        peerLastReadSeq: conversation.data?.peerLastReadSeq ?? null,
      }),
    [messages, outbox, myId, isGroup, conversation.data?.peerLastReadSeq],
  );

  // Reading: once the newest message is on screen and the app is in front, tell the server.
  const newestSeq = messages?.at(-1)?.seq ?? 0;
  const lastReadSeq = conversation.data?.lastReadSeq ?? 0;
  const markedSeq = useRef(0);
  useEffect(() => {
    if (!appActive || !conversation.data || newestSeq <= lastReadSeq) return;
    if (markedSeq.current >= newestSeq) return;
    markedSeq.current = newestSeq;
    actions.markRead(id, newestSeq).catch(() => {
      markedSeq.current = 0; // try again on the next change
    });
  }, [appActive, conversation.data, newestSeq, lastReadSeq, id]);

  const onReact = useCallback(
    (message: Message, emoji: string) => {
      actions.react(id, message.id, emoji).catch((e: unknown) => fail('Couldn’t react', e));
    },
    [id],
  );

  const sheetActions = useMemo((): MessageAction[] => {
    const m = actionsFor;
    if (!m || m.deletedAt) return [];
    const list: MessageAction[] = [
      {
        label: 'Reply',
        onPress: () => {
          setEditing(null);
          setReplyTo(m);
        },
      },
    ];
    if (canEditMessage(m, myId)) {
      list.push({
        label: 'Edit',
        onPress: () => {
          setReplyTo(null);
          setEditing(m);
        },
      });
    }
    if (canDeleteMessage(m, myId)) {
      list.push({
        label: 'Delete for everyone',
        destructive: true,
        onPress: () =>
          Alert.alert('Delete this message?', 'It will be deleted for everyone in the chat.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () =>
                void actions
                  .deleteMessageForEveryone(id, m.id)
                  .catch((e: unknown) => fail('Couldn’t delete', e)),
            },
          ]),
      });
    }
    return list;
  }, [actionsFor, myId, id]);

  function onSend(text: string) {
    if (editing) {
      const target = editing;
      setEditing(null);
      actions.editMessageText(id, target.id, text).catch((e: unknown) => fail('Couldn’t edit', e));
      return;
    }
    const replyToId = replyTo?.id ?? null;
    setReplyTo(null);
    void queueTextMessage({ conversationId: id, body: text, replyToId });
  }

  async function upload(file: PickedFile) {
    setUploadError(null);
    setUploading({ name: file.name, progress: 0 });
    try {
      await sendAttachment(id, file, { replyToId: replyTo?.id ?? null }, (progress) =>
        setUploading({ name: file.name, progress }),
      );
      setReplyTo(null);
    } catch (e) {
      setUploadError(describeError(e));
    } finally {
      setUploading(null);
    }
  }

  function onAttach() {
    const choose = (pick: () => Promise<PickedFile | null>) => () =>
      void pick()
        .then((file) => file && upload(file))
        .catch((e: unknown) => fail('Couldn’t attach that', e));
    Alert.alert('Send', undefined, [
      { text: 'Photo', onPress: choose(pickPhoto) },
      { text: 'File', onPress: choose(pickFile) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => {
      if (item.kind === 'day') {
        return <Text style={[styles.day, { color: t.muted }]}>{item.label}</Text>;
      }
      if (item.kind === 'pending') {
        const failed = item.item.state === 'failed';
        return (
          <View style={styles.pendingWrap}>
            <View
              style={[styles.pending, { backgroundColor: t.accent, opacity: failed ? 1 : 0.6 }]}
            >
              <Text style={{ color: t.accentText, fontSize: 16 }}>{item.item.body}</Text>
            </View>
            {failed ? (
              <View style={styles.pendingActions}>
                <Text style={{ color: t.error, fontSize: 12 }}>
                  Not sent{item.item.error ? `: ${item.item.error}` : ''}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void retryOutboxMessage(item.item.clientMsgId)}
                >
                  <Text style={{ color: t.accent, fontWeight: '600' }}>Retry</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void discardOutboxMessage(item.item.clientMsgId)}
                >
                  <Text style={{ color: t.error, fontWeight: '600' }}>Delete</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {online ? 'Sending…' : 'Waiting for connection'}
              </Text>
            )}
          </View>
        );
      }
      return (
        <MessageBubble
          message={item.message}
          mine={item.mine}
          myId={myId}
          showSender={item.showSender}
          senderName={item.message.senderId ? (names.get(item.message.senderId) ?? null) : null}
          seen={item.seen}
          onLongPress={setActionsFor}
          onReact={onReact}
        />
      );
    },
    [t, online, myId, names, onReact],
  );

  const title = conversation.data ? conversationTitle(conversation.data) : 'Chat';

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { borderBottomColor: t.border, backgroundColor: t.card }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={styles.back}
        >
          <Text style={{ color: t.accent, fontSize: 28 }}>‹</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}. Chat info`}
          onPress={() => router.push(`/c/${id}/info`)}
          style={styles.titleWrap}
        >
          <Text numberOfLines={1} style={[styles.title, { color: t.text }]}>
            {title}
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              style={[styles.subtitle, { color: typing ? t.accent : t.muted }]}
            >
              {subtitle}
            </Text>
          ) : null}
        </Pressable>
      </View>
      {!online ? (
        <Banner>You’re offline. Messages will send when you’re back online.</Banner>
      ) : null}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {view.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator accessibilityLabel="Loading messages" />
          </View>
        ) : view.error && !messages ? (
          <View style={styles.center}>
            <Text style={{ color: t.error, textAlign: 'center', padding: 24 }}>
              {describeError(view.error)}
            </Text>
          </View>
        ) : (
          <FlatList
            style={styles.flex}
            data={rows}
            inverted
            keyExtractor={(r) => r.key}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            onEndReached={() => void view.loadOlder()}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              view.loadingOlder ? <ActivityIndicator style={styles.older} /> : null
            }
            ListEmptyComponent={
              <Text style={[styles.empty, { color: t.muted }]}>No messages yet. Say hello!</Text>
            }
            contentContainerStyle={styles.listContent}
            initialNumToRender={20}
            windowSize={9}
            removeClippedSubviews={Platform.OS === 'android'}
          />
        )}
        <View
          style={{ paddingBottom: keyboardVisible ? 0 : insets.bottom, backgroundColor: t.card }}
        >
          <Composer
            replyTo={replyTo}
            editing={editing}
            uploading={uploading}
            uploadError={uploadError}
            onSend={onSend}
            onTyping={sendTyping}
            onAttach={onAttach}
            onCancelContext={() => {
              setReplyTo(null);
              setEditing(null);
            }}
          />
        </View>
      </KeyboardAvoidingView>
      <MessageActions
        message={actionsFor}
        actions={sheetActions}
        onReact={(emoji) => actionsFor && onReact(actionsFor, emoji)}
        onClose={() => setActionsFor(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 52,
  },
  back: { width: 48, height: 52, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flex: 1, justifyContent: 'center', minHeight: 52 },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 12 },
  listContent: { paddingVertical: 8 },
  day: { alignSelf: 'center', fontSize: 12, marginVertical: 8 },
  older: { padding: 12 },
  // No scaleY here: the list already flips its empty component back upright.
  empty: { textAlign: 'center', padding: 24 },
  pendingWrap: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    marginVertical: 2,
    maxWidth: '85%',
    gap: 2,
  },
  pending: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  pendingActions: { flexDirection: 'row', gap: 12, alignItems: 'center' },
});

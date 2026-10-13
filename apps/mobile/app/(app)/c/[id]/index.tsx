import { REPORT_REASONS, type Message, type ReportReason } from '@videochat/shared';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
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
import { CallButton } from '../../../../src/calls/CallButton';
import { useCalls } from '../../../../src/calls/CallProvider';
import { AttachSheet, type AttachChoice } from '../../../../src/chat/AttachSheet';
import {
  CameraUnavailableError,
  pickFile,
  pickPhoto,
  takePhoto,
  type PickedFile,
} from '../../../../src/chat/attachments';
import { Composer } from '../../../../src/chat/Composer';
import { MessageActions, type MessageAction } from '../../../../src/chat/MessageActions';
import { MessageBubble } from '../../../../src/chat/MessageBubble';
import { buildRows, type ChatRow } from '../../../../src/chat/rows';
import { UploadBubble } from '../../../../src/chat/UploadBubble';
import * as actions from '../../../../src/data/actions';
import { reportMessage } from '../../../../src/data/api';
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
import { uploads, useConversationUploads } from '../../../../src/uploads';
import { success } from '../../../../src/ui/haptics';
import { Banner } from '../../../../src/ui/Banner';
import { describeError } from '../../../../src/ui/describeError';
import { canDeleteMessage, canEditMessage, conversationTitle } from '../../../../src/ui/format';
import { useTheme } from '../../../../src/ui/theme';
import { useKeyboardVisible } from '../../../../src/ui/useKeyboardVisible';

const REPORT_LABELS: Record<ReportReason, string> = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  inappropriate: 'Inappropriate content',
  other: 'Something else',
};

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
  const uploading = useConversationUploads(id);
  const isGroup = conversation.data?.type === 'group';
  const members = useMembers(id, isGroup);
  const online = useIsOnline();
  const appActive = useAppActive();
  useViewingReporter(id);
  const sendTyping = useTypingSender(id);
  const typing = useTypingLabel(id);
  const calls = useCalls();
  const peer = !isGroup ? (conversation.data?.peer ?? null) : null;
  const peerId = peer?.id ?? null;
  const presence = usePresence(peerId ? [peerId] : []);
  const subtitle = typing ?? (peerId ? presenceLabel(presence.get(peerId)) : null);

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [reportFor, setReportFor] = useState<Message | null>(null);

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
        uploads: uploading,
        myId,
        isGroup,
        peerLastReadSeq: conversation.data?.peerLastReadSeq ?? null,
      }),
    [messages, outbox, uploading, myId, isGroup, conversation.data?.peerLastReadSeq],
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

  // iOS cannot present a Modal while another one is still dismissing, so the report sheet waits
  // for the actions sheet's `onDismiss`. Android has no such event and shows it straight away.
  const [pendingReport, setPendingReport] = useState<Message | null>(null);
  const onActionsDismissed = useCallback(() => {
    if (pendingReport) setReportFor(pendingReport);
    setPendingReport(null);
  }, [pendingReport]);

  const onReply = useCallback((m: Message) => {
    setEditing(null);
    setReplyTo(m);
  }, []);

  const onCopy = useCallback((m: Message) => {
    if (!m.body) return;
    void Clipboard.setStringAsync(m.body)
      .then(success)
      .catch(() => undefined);
  }, []);

  const sheetActions = useMemo((): MessageAction[] => {
    const m = actionsFor;
    if (!m || m.deletedAt) return [];
    const list: MessageAction[] = [{ label: 'Reply', onPress: () => onReply(m) }];
    if (m.body) list.push({ label: 'Copy text', onPress: () => onCopy(m) });
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
    if (
      m.senderId &&
      m.senderId !== myId &&
      (m.type === 'text' || m.type === 'image' || m.type === 'file')
    ) {
      list.push({
        label: 'Report',
        destructive: true,
        onPress: () => (Platform.OS === 'ios' ? setPendingReport(m) : setReportFor(m)),
      });
    }
    return list;
  }, [actionsFor, myId, id, onReply, onCopy]);

  const reportActions = useMemo((): MessageAction[] => {
    const target = reportFor;
    if (!target) return [];
    return REPORT_REASONS.map((reason) => ({
      label: REPORT_LABELS[reason],
      onPress: () =>
        void reportMessage(id, target.id, { reason })
          .then(() => {
            success();
            Alert.alert('Thanks for letting us know', 'We’ll look at this message.');
          })
          .catch((e: unknown) => fail('Couldn’t send the report', e)),
    }));
  }, [reportFor, id]);

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

  function startUpload(file: PickedFile) {
    // The manager owns it from here: it keeps going if this screen is left, and shows up as a
    // bubble in the list with its progress.
    uploads.start(id, file, { replyToId: replyTo?.id ?? null });
    setReplyTo(null);
  }

  function onAttachChoice(choice: AttachChoice) {
    const pick = choice === 'camera' ? takePhoto : choice === 'library' ? pickPhoto : pickFile;
    void pick()
      .then((file) => file && startUpload(file))
      .catch((e: unknown) => {
        if (e instanceof CameraUnavailableError) {
          Alert.alert(
            'Camera is off',
            e.message,
            e.canAskAgain
              ? [{ text: 'OK' }]
              : [
                  { text: 'Not now', style: 'cancel' },
                  { text: 'Open Settings', onPress: () => void Linking.openSettings() },
                ],
          );
          return;
        }
        fail('Couldn’t attach that', e);
      });
  }

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => {
      if (item.kind === 'day') {
        return <Text style={[styles.day, { color: t.muted }]}>{item.label}</Text>;
      }
      if (item.kind === 'upload') {
        return (
          <UploadBubble
            entry={item.entry}
            onRetry={() => uploads.retry(item.entry.id)}
            onDiscard={() => uploads.discard(item.entry.id)}
          />
        );
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
          onReply={onReply}
          onCopy={onCopy}
          onReact={onReact}
        />
      );
    },
    [t, online, myId, names, onReact, onReply, onCopy],
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
        {peer ? (
          <>
            <CallButton
              label={`Audio call ${peer.displayName}`}
              glyph="✆"
              onPress={() => void calls.startCall({ conversationId: id, peer, media: 'audio' })}
            />
            <CallButton
              label={`Video call ${peer.displayName}`}
              glyph="📹"
              onPress={() => void calls.startCall({ conversationId: id, peer, media: 'video' })}
            />
          </>
        ) : null}
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
            onSend={onSend}
            onTyping={sendTyping}
            onAttach={() => setAttachOpen(true)}
            onCancelContext={() => {
              setReplyTo(null);
              setEditing(null);
            }}
          />
        </View>
      </KeyboardAvoidingView>
      <AttachSheet
        visible={attachOpen}
        onChoose={onAttachChoice}
        onClose={() => setAttachOpen(false)}
      />
      <MessageActions
        message={reportFor}
        title="Report this message"
        actions={reportActions}
        onClose={() => setReportFor(null)}
      />
      <MessageActions
        message={actionsFor}
        actions={sheetActions}
        onReact={(emoji) => actionsFor && onReact(actionsFor, emoji)}
        onClose={() => setActionsFor(null)}
        onDismissed={onActionsDismissed}
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

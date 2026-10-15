import type { Message, Reaction } from '@videochat/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { callLabel, formatClock } from '../ui/format';
import { useTheme } from '../ui/theme';
import { AttachmentView } from './AttachmentView';
import { SwipeToReply } from './SwipeToReply';

interface Props {
  message: Message;
  mine: boolean;
  myId: string;
  showSender: boolean;
  senderName: string | null;
  seen: boolean;
  onLongPress: (message: Message) => void;
  /** Swipe right (or the screen reader's "Reply" action). */
  onReply: (message: Message) => void;
  onCopy: (message: Message) => void;
  onReact: (message: Message, emoji: string) => void;
  /** CHAT-072: briefly outlined after jumping to it from search. */
  highlighted?: boolean;
}

function ReplyQuote({ message, mine }: { message: Message; mine: boolean }) {
  const t = useTheme();
  const reply = message.replyTo;
  if (!reply) return null;
  const text = reply.deleted
    ? 'Deleted message'
    : (reply.snippet ?? (reply.attachment ? reply.attachment.filename : 'Message'));
  return (
    <View style={[styles.quote, { borderLeftColor: mine ? t.accentText : t.accent }]}>
      <Text numberOfLines={2} style={{ color: mine ? t.accentText : t.muted, fontSize: 13 }}>
        {text}
      </Text>
    </View>
  );
}

function Reactions({
  reactions,
  myId,
  onToggle,
}: {
  reactions: Reaction[];
  myId: string;
  onToggle: (emoji: string) => void;
}) {
  const t = useTheme();
  return (
    <View style={styles.reactions}>
      {reactions.map((r) => {
        const mineReacted = r.userIds.includes(myId);
        return (
          <Pressable
            key={r.emoji}
            accessibilityRole="button"
            accessibilityLabel={`${r.emoji} ${r.count}${mineReacted ? ', you reacted' : ''}`}
            onPress={() => onToggle(r.emoji)}
            style={[
              styles.reaction,
              {
                borderColor: mineReacted ? t.accent : t.border,
                backgroundColor: t.card,
              },
            ]}
          >
            <Text style={{ color: t.text, fontSize: 13 }}>
              {r.emoji} {r.count}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function MessageBubbleBase({
  message,
  mine,
  myId,
  showSender,
  senderName,
  seen,
  onLongPress,
  onReply,
  onCopy,
  onReact,
  highlighted = false,
}: Props) {
  const t = useTheme();

  if (message.type === 'system' || message.type === 'call') {
    const text = message.type === 'call' ? callLabel(message, myId) : (message.body ?? '');
    return (
      <Text style={[styles.centerNote, { color: t.muted }]} accessibilityRole="text">
        {text}
      </Text>
    );
  }

  const deleted = message.deletedAt !== null;
  const textColor = mine ? t.accentText : t.text;
  // Everything the long-press menu offers is also reachable with a screen reader's actions.
  const a11yActions = deleted
    ? undefined
    : [
        { name: 'reply', label: 'Reply' },
        ...(message.body ? [{ name: 'copy', label: 'Copy text' }] : []),
        { name: 'menu', label: 'More: react, edit, delete, report' },
      ];
  return (
    <SwipeToReply enabled={!deleted} onReply={() => onReply(message)}>
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        {showSender && senderName ? (
          <Text style={[styles.sender, { color: t.muted }]}>{senderName}</Text>
        ) : null}
        <Pressable
          accessibilityHint="Long press for reactions, reply and more"
          accessibilityActions={a11yActions}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'reply') onReply(message);
            else if (e.nativeEvent.actionName === 'copy') onCopy(message);
            else if (e.nativeEvent.actionName === 'menu') onLongPress(message);
          }}
          onLongPress={() => onLongPress(message)}
          delayLongPress={250}
          style={[
            styles.bubble,
            mine
              ? { backgroundColor: t.accent }
              : { backgroundColor: t.card, borderColor: t.border },
            !mine && styles.bubbleBorder,
            highlighted && [styles.highlighted, { borderColor: mine ? t.text : t.accent }],
          ]}
        >
          {deleted ? (
            <Text style={{ color: mine ? t.accentText : t.muted, fontStyle: 'italic' }}>
              This message was deleted
            </Text>
          ) : (
            <>
              <ReplyQuote message={message} mine={mine} />
              {message.attachment ? <AttachmentView attachment={message.attachment} /> : null}
              {message.body ? (
                <Text selectable style={{ color: textColor, fontSize: 16 }}>
                  {message.body}
                </Text>
              ) : null}
            </>
          )}
          <Text style={[styles.meta, { color: mine ? t.accentText : t.muted }]}>
            {formatClock(message.createdAt)}
            {message.editedAt && !deleted ? ' · edited' : ''}
          </Text>
        </Pressable>
        {!deleted && message.reactions?.length ? (
          <Reactions
            reactions={message.reactions}
            myId={myId}
            onToggle={(emoji) => onReact(message, emoji)}
          />
        ) : null}
        {seen ? <Text style={[styles.seen, { color: t.muted }]}>Seen</Text> : null}
      </View>
    </SwipeToReply>
  );
}

export const MessageBubble = memo(MessageBubbleBase);

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, marginVertical: 2, maxWidth: '85%' },
  rowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  sender: { fontSize: 12, marginBottom: 2, marginLeft: 4 },
  bubble: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  bubbleBorder: { borderWidth: StyleSheet.hairlineWidth },
  highlighted: { borderWidth: 2 },
  quote: { borderLeftWidth: 3, paddingLeft: 8, marginBottom: 2 },
  meta: { fontSize: 11, alignSelf: 'flex-end', opacity: 0.8 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  reaction: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  seen: { fontSize: 11, marginTop: 2, marginRight: 4 },
  centerNote: { alignSelf: 'center', fontSize: 13, marginVertical: 6, textAlign: 'center' },
});

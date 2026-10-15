import { mentionParts, type Message, type Reaction } from '@videochat/shared';
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
  /** CHAT-073: members' usernames by id, for highlighting @mentions. */
  usernames?: ReadonlyMap<string, string>;
}

/** CHAT-073: the text with its @mentions highlighted (strongly when it's you). */
function BodyText({
  message,
  myId,
  color,
  usernames,
}: {
  message: Message;
  myId: string;
  color: string;
  usernames?: ReadonlyMap<string, string>;
}) {
  const t = useTheme();
  const mentioned = new Map<string, boolean>();
  for (const id of message.mentions ?? []) {
    const username = usernames?.get(id);
    // mentionParts reports usernames lowercased.
    if (username) mentioned.set(username.toLowerCase(), id === myId);
  }
  const parts =
    mentioned.size > 0
      ? mentionParts(message.body ?? '', (u) => mentioned.has(u))
      : [{ text: message.body ?? '' }];
  return (
    <Text selectable style={{ color, fontSize: 16 }}>
      {parts.map((part, i) =>
        part.mention ? (
          <Text
            key={i}
            style={[
              { fontWeight: '700' },
              mentioned.get(part.mention) && { backgroundColor: t.border },
            ]}
          >
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
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
  usernames,
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
            // CHAT-073: a message that mentions you stands out.
            !mine &&
              !deleted &&
              message.mentions?.includes(myId) && [
                styles.mentionsMe,
                { borderLeftColor: t.accent },
              ],
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
                <BodyText message={message} myId={myId} color={textColor} usernames={usernames} />
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
  mentionsMe: { borderLeftWidth: 3 },
  quote: { borderLeftWidth: 3, paddingLeft: 8, marginBottom: 2 },
  meta: { fontSize: 11, alignSelf: 'flex-end', opacity: 0.8 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  reaction: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  seen: { fontSize: 11, marginTop: 2, marginRight: 4 },
  centerNote: { alignSelf: 'center', fontSize: 13, marginVertical: 6, textAlign: 'center' },
});

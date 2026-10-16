import {
  activeMention,
  formatVoiceTime,
  insertMention,
  LIMITS,
  matchMembers,
  type MemberSummary,
  type Message,
} from '@videochat/shared';
import { useState } from 'react';
import type { CapturedVoice } from '../voice/capture';
import { HoldToRecordButton, type RecordingState } from '../voice/HoldToRecordButton';
import { WaveformBars } from '../voice/VoiceMessageView';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../ui/theme';

export interface ComposerProps {
  replyTo: Message | null;
  editing: Message | null;
  onSend: (text: string) => void;
  /** Called on every change of the text, for the "typing…" signal. */
  onTyping?: () => void;
  onAttach: () => void;
  onCancelContext: () => void;
  /** CHAT-073: a group's members, offered after typing "@" (omit for a direct chat). */
  members?: MemberSummary[];
  myId?: string;
  /** CHAT-074: a recorded voice message to send (the microphone shows while the box is empty). */
  onVoice?: (voice: CapturedVoice) => void;
  /** Why recording isn't possible right now (a call), or null. */
  voiceDisabledReason?: string | null;
}

function quotePreview(m: Message): string {
  if (m.deletedAt) return 'Deleted message';
  return m.body ?? m.attachment?.filename ?? 'Message';
}

export function Composer({
  replyTo,
  editing,
  onSend,
  onTyping,
  onAttach,
  onCancelContext,
  members,
  myId,
  onVoice,
  voiceDisabledReason = null,
}: ComposerProps) {
  const t = useTheme();
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<RecordingState | null>(null);
  // CHAT-073: where the caret is, for "@" suggestions; `forced` moves it after picking a name.
  const [caret, setCaret] = useState<number | null>(null);
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>(undefined);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const mention = members && caret !== null ? activeMention(text, caret) : null;
  const suggestions =
    mention && mention.start !== dismissedAt
      ? matchMembers(members ?? [], mention.query, myId ?? null, 5)
      : [];

  function pickMention(member: MemberSummary) {
    if (!mention || caret === null) return;
    const next = insertMention(text, mention.start, caret, member.username);
    setText(next.text);
    setCaret(next.caret);
    setForced({ start: next.caret, end: next.caret });
  }

  // Starting an edit puts the message's text in the box (adjusting state while rendering, the
  // supported way to reset state when a prop changes).
  const [seenEditing, setSeenEditing] = useState<Message | null>(null);
  // What was typed before an edit began, put back when the edit ends (saved, cancelled, or
  // replaced by choosing Reply).
  const [draft, setDraft] = useState('');
  if (editing !== seenEditing) {
    setSeenEditing(editing);
    // Starting an edit loads the message; leaving edit mode (by choosing Reply, say) must not
    // leave the old text behind to be sent as something else.
    if (editing) {
      if (!seenEditing) setDraft(text);
      setText(editing.body ?? '');
    } else if (seenEditing) {
      setText(draft);
      setDraft('');
    }
  }

  const trimmed = text.trim();
  const canSend = trimmed.length > 0;

  function send() {
    if (!canSend) return;
    onSend(trimmed);
    // Saving an edit hands the box back to the draft (when the parent ends the edit).
    if (!editing) setText('');
  }

  const context = editing
    ? 'Editing message'
    : replyTo
      ? `Replying: ${quotePreview(replyTo)}`
      : null;

  return (
    <View style={[styles.wrap, { backgroundColor: t.card, borderTopColor: t.border }]}>
      {context ? (
        <View style={styles.context}>
          <Text numberOfLines={1} style={[styles.contextText, { color: t.muted }]}>
            {context}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={() => {
              onCancelContext();
            }}
          >
            <Text style={{ color: t.accent, fontWeight: '600' }}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      {suggestions.length > 0 ? (
        <View
          accessibilityLabel="Mention someone"
          style={[styles.mentions, { borderColor: t.border, backgroundColor: t.bg }]}
        >
          {suggestions.map((m) => (
            <Pressable
              key={m.userId}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${m.displayName}`}
              onPress={() => pickMention(m)}
              style={styles.mention}
            >
              <Text style={{ color: t.text, fontWeight: '600' }}>{m.displayName}</Text>
              <Text style={{ color: t.muted }}>@{m.username}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close suggestions"
            onPress={() => setDismissedAt(mention!.start)}
            style={styles.mention}
          >
            <Text style={{ color: t.muted }}>Close</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.row}>
        {!editing ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach a photo or file"
            onPress={onAttach}
            style={styles.attach}
          >
            <Text style={{ color: t.accent, fontSize: 26 }}>+</Text>
          </Pressable>
        ) : null}
        {voice?.recording ? (
          <View
            style={[styles.recording, { backgroundColor: t.bg, borderColor: t.border }]}
            accessibilityLiveRegion="polite"
          >
            <View style={[styles.dot, { backgroundColor: t.error }]} />
            <Text style={{ color: t.text, fontVariant: ['tabular-nums'] }}>
              {formatVoiceTime(voice.elapsedMs)}
            </Text>
            <View style={styles.level}>
              <WaveformBars
                waveform={[
                  ...Array.from({ length: 32 - voice.levels.length }, () => 0),
                  ...voice.levels.map((l) => Math.round(l * 100)),
                ]}
                progress={1}
                color={voice.cancelling ? t.muted : t.accent}
              />
            </View>
            <Text style={{ color: voice.cancelling ? t.error : t.muted, fontSize: 13 }}>
              {voice.cancelling ? 'Release to cancel' : '‹ Slide to cancel'}
            </Text>
          </View>
        ) : (
          <TextInput
            accessibilityLabel="Message"
            value={text}
            onChangeText={(value) => {
              setText(value);
              if (!editing && value.trim().length > 0) onTyping?.();
            }}
            selection={forced}
            onSelectionChange={(e) => {
              setCaret(e.nativeEvent.selection.end);
              if (forced) setForced(undefined);
            }}
            placeholder="Message"
            placeholderTextColor={t.muted}
            multiline
            maxLength={LIMITS.messageMaxLength}
            style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: t.border }]}
          />
        )}
        {onVoice && !editing && (!canSend || voice?.recording) ? (
          <HoldToRecordButton
            disabledReason={voiceDisabledReason}
            onRecorded={onVoice}
            onState={(state) => setVoice(state.recording ? state : null)}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Save edit' : 'Send'}
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={send}
            style={[styles.send, { backgroundColor: t.accent, opacity: canSend ? 1 : 0.4 }]}
          >
            <Text style={{ color: t.accentText, fontWeight: '700' }}>
              {editing ? 'Save' : 'Send'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
  },
  context: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  contextText: { flex: 1, fontSize: 13 },
  error: { fontSize: 13, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  attach: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
  },
  mentions: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  mention: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  recording: {
    flex: 1,
    minHeight: 40,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  level: { flex: 1, height: 24 },
  send: { height: 40, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center' },
});

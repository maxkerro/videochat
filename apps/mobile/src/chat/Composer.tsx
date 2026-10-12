import { LIMITS, type Message } from '@videochat/shared';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../ui/theme';

export interface ComposerProps {
  replyTo: Message | null;
  editing: Message | null;
  /** Shown while a file is uploading. */
  uploading: { name: string; progress: number } | null;
  uploadError: string | null;
  onSend: (text: string) => void;
  onAttach: () => void;
  onCancelContext: () => void;
}

function quotePreview(m: Message): string {
  if (m.deletedAt) return 'Deleted message';
  return m.body ?? m.attachment?.filename ?? 'Message';
}

export function Composer({
  replyTo,
  editing,
  uploading,
  uploadError,
  onSend,
  onAttach,
  onCancelContext,
}: ComposerProps) {
  const t = useTheme();
  const [text, setText] = useState('');

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
  const canSend = trimmed.length > 0 && uploading === null;

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
      {uploading ? (
        <View style={styles.context}>
          <ActivityIndicator />
          <Text numberOfLines={1} style={[styles.contextText, { color: t.muted }]}>
            Sending {uploading.name} · {Math.round(uploading.progress * 100)}%
          </Text>
        </View>
      ) : null}
      {uploadError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.error, { color: t.error }]}>
          {uploadError}
        </Text>
      ) : null}
      <View style={styles.row}>
        {!editing ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach a photo or file"
            disabled={uploading !== null}
            onPress={onAttach}
            style={styles.attach}
          >
            <Text style={{ color: t.accent, fontSize: 26 }}>+</Text>
          </Pressable>
        ) : null}
        <TextInput
          accessibilityLabel="Message"
          value={text}
          onChangeText={setText}
          placeholder="Message"
          placeholderTextColor={t.muted}
          multiline
          maxLength={LIMITS.messageMaxLength}
          style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: t.border }]}
        />
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
  send: { height: 40, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center' },
});

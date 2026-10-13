import { QUICK_REACTIONS, type Message } from '@videochat/shared';
import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { select, tick } from '../ui/haptics';
import { useTheme } from '../ui/theme';

export interface MessageAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

/** The sheet that opens on a long press: quick reactions, then what you can do with the message. */
export function MessageActions({
  message,
  actions,
  onReact,
  onClose,
  onDismissed,
  title,
}: {
  message: Message | null;
  actions: MessageAction[];
  /** Omit for a menu without the reaction bar (the report reasons). */
  onReact?: (emoji: string) => void;
  onClose: () => void;
  /** After the sheet has fully closed (iOS only fires it; see the screen's `openAfterClose`). */
  onDismissed?: () => void;
  title?: string;
}) {
  const t = useTheme();
  const visible = message !== null;
  // A light tick as the menu opens.
  useEffect(() => {
    if (visible) tick();
  }, [visible]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onDismissed}
    >
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.backdrop, { backgroundColor: '#00000066' }]}
      />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: t.card }]}>
        {title ? (
          <Text style={[styles.title, { color: t.muted }]} accessibilityRole="header">
            {title}
          </Text>
        ) : null}
        {onReact ? (
          <View style={styles.reactions}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={`React ${emoji}`}
                onPress={() => {
                  select();
                  onReact(emoji);
                  onClose();
                }}
                style={styles.emoji}
              >
                <Text style={{ fontSize: 28 }}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {actions.map((a) => (
          <Pressable
            key={a.label}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              a.onPress();
            }}
            style={[styles.action, { borderTopColor: t.border }]}
          >
            <Text style={{ color: a.destructive ? t.error : t.text, fontSize: 16 }}>{a.label}</Text>
          </Pressable>
        ))}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', padding: 12 },
  emoji: { padding: 6 },
  title: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4, fontSize: 13 },
  action: { paddingVertical: 16, paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth },
});

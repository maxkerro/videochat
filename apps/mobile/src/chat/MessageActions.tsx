import { QUICK_REACTIONS, type Message } from '@videochat/shared';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
}: {
  message: Message | null;
  actions: MessageAction[];
  onReact: (emoji: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  return (
    <Modal visible={message !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.backdrop, { backgroundColor: '#00000066' }]}
      />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: t.card }]}>
        <View style={styles.reactions}>
          {QUICK_REACTIONS.map((emoji) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`React ${emoji}`}
              onPress={() => {
                onReact(emoji);
                onClose();
              }}
              style={styles.emoji}
            >
              <Text style={{ fontSize: 28 }}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
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
  action: { paddingVertical: 16, paddingHorizontal: 20, borderTopWidth: StyleSheet.hairlineWidth },
});

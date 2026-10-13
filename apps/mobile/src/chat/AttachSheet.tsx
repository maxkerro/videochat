import { Modal, Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../ui/theme';

export type AttachChoice = 'camera' | 'library' | 'file';

const CHOICES: Array<{ choice: AttachChoice; label: string }> = [
  { choice: 'camera', label: 'Take a photo' },
  { choice: 'library', label: 'Choose a photo' },
  { choice: 'file', label: 'Choose a file' },
];

/** CHAT-056: what to send -- camera, photo library or a file. */
export function AttachSheet({
  visible,
  onChoose,
  onClose,
}: {
  visible: boolean;
  onChoose: (choice: AttachChoice) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.backdrop, { backgroundColor: '#00000066' }]}
      />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: t.card }]}>
        {CHOICES.map(({ choice, label }, i) => (
          <Pressable
            key={choice}
            accessibilityRole="button"
            onPress={() => {
              onClose();
              onChoose(choice);
            }}
            style={[styles.action, i > 0 && { borderTopColor: t.border, borderTopWidth: 1 }]}
          >
            <Text style={{ color: t.text, fontSize: 16 }}>{label}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={[styles.action, { borderTopColor: t.border, borderTopWidth: 1 }]}
        >
          <Text style={{ color: t.muted, fontSize: 16 }}>Cancel</Text>
        </Pressable>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1 },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  action: { paddingVertical: 16, paddingHorizontal: 20 },
});

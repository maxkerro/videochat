import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../ui/theme';

/** A call button for the conversation header. */
export function CallButton({
  label,
  glyph,
  onPress,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.5 : 1 }]}
    >
      <Text style={[styles.glyph, { color: t.accent }]}>{glyph}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 52, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 22 },
});

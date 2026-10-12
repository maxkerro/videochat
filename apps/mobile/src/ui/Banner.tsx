import { StyleSheet, Text } from 'react-native';
import { useTheme } from './theme';

/** A thin strip under the header for state that matters but is not an error screen. */
export function Banner({ children }: { children: string }) {
  const t = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: t.border, color: t.text }]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  banner: { paddingVertical: 6, paddingHorizontal: 16, fontSize: 13, textAlign: 'center' },
});

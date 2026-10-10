import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from './theme';

export function FormScreen({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: t.bg }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>
            {title}
          </Text>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Field({
  label,
  error,
  ...input
}: TextInputProps & { label: string; error?: string | undefined }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        style={[
          styles.input,
          { color: t.text, backgroundColor: t.card, borderColor: error ? t.error : t.border },
        ]}
        {...input}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.error, { color: t.error }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Button({
  title,
  onPress,
  busy,
  kind = 'primary',
}: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  kind?: 'primary' | 'link';
}) {
  const t = useTheme();
  const primary = kind === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      disabled={busy}
      onPress={onPress}
      style={[
        styles.button,
        primary ? { backgroundColor: t.accent, opacity: busy ? 0.6 : 1 } : styles.linkButton,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={t.accentText} />
      ) : (
        <Text style={[styles.buttonText, { color: primary ? t.accentText : t.accent }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  const t = useTheme();
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={[styles.notice, { color: kind === 'error' ? t.error : t.ok }]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { fontSize: 13 },
  button: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  linkButton: { minHeight: 40 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  notice: { fontSize: 14 },
});

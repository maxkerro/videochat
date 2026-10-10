import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { Button } from '../src/ui/Form';
import { useTheme } from '../src/ui/theme';

function Gate() {
  const { state, retry } = useAuth();
  const t = useTheme();

  if (state.status === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }

  if (state.status === 'offline') {
    // A stored session exists but the server wasn't reachable: stay signed in, offer a retry.
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <Text style={[styles.message, { color: t.text }]}>
          Can’t reach the server. Check your connection.
        </Text>
        <Button title="Try again" onPress={retry} />
      </View>
    );
  }

  const signedIn = state.status === 'signedIn';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="auto" />
      <Gate />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  message: { fontSize: 16, textAlign: 'center' },
});

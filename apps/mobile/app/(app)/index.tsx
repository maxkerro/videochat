import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { z } from 'zod';
import { useAuth } from '../../src/auth/AuthContext';
import { apiGet, config } from '../../src/lib/api';
import { Button } from '../../src/ui/Form';

type Status = { kind: 'loading' } | { kind: 'ok' } | { kind: 'error'; message: string };

/** Placeholder home screen: proves the signed-in app reaches the API with its bearer token. The
 *  inbox replaces it in CHAT-052. */
export default function Home() {
  const { state, logout } = useAuth();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  const probe = useCallback(() => {
    apiGet('/me', z.unknown())
      .then(() => setStatus({ kind: 'ok' }))
      .catch((e: unknown) =>
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  const retry = useCallback(() => {
    setStatus({ kind: 'loading' });
    probe();
  }, [probe]);

  // The initial state is already "loading", so the first probe only sets state when it resolves.
  useEffect(probe, [probe]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title}>Chat</Text>
        {state.status === 'signedIn' && (
          <Text accessibilityRole="text">Signed in as {state.user.displayName}</Text>
        )}
        <Text style={styles.muted}>
          {config.variant} · {config.apiUrl}
        </Text>
        {status.kind === 'loading' && <ActivityIndicator accessibilityLabel="Checking server" />}
        {status.kind === 'ok' && <Text style={styles.ok}>Server reachable</Text>}
        {status.kind === 'error' && (
          <>
            <Text style={styles.error}>Can't reach the server: {status.message}</Text>
            <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </>
        )}
        <Button title="Log out" kind="link" onPress={() => void logout()} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 28, fontWeight: '700' },
  muted: { color: '#6b6b6b' },
  ok: { color: '#1a7f37', fontWeight: '600' },
  error: { color: '#b3261e', textAlign: 'center' },
  button: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: '#333' },
  buttonText: { color: '#fff', fontWeight: '600' },
});

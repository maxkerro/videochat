import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { useAuth } from '../../src/auth/AuthContext';
import { DataProvider } from '../../src/data/DataProvider';
import { useTheme } from '../../src/ui/theme';

function ThemedStack() {
  const t = useTheme();
  const { state } = useAuth();
  const preference = state.status === 'signedIn' ? state.user.settings.theme : 'system';

  // The theme setting follows the account across devices (CHAT-037).
  useEffect(() => {
    Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
  }, [preference]);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.accent,
        headerTitleStyle: { color: t.text },
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Chats' }} />
      <Stack.Screen name="c/[id]/index" options={{ headerShown: false }} />
      <Stack.Screen name="c/[id]/info" options={{ title: 'Chat info' }} />
      <Stack.Screen name="new" options={{ title: 'New chat' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}

export default function AppLayout() {
  return (
    <DataProvider>
      <ThemedStack />
    </DataProvider>
  );
}

import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { Appearance, View } from 'react-native';
import { useAuth } from '../../src/auth/AuthContext';
import { CallOverlay } from '../../src/calls/CallOverlay';
import { CallProvider, useCalls } from '../../src/calls/CallProvider';
import { GroupCallProvider, useGroupCall } from '../../src/groupCalls/GroupCallProvider';
import { voicePlayback } from '../../src/voice';
import { loadCallPrefs } from '../../src/calls/callPrefs';
import { DataProvider } from '../../src/data/DataProvider';
import { PushProvider } from '../../src/push/PushProvider';
import { RealtimeProvider } from '../../src/realtime/RealtimeProvider';
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
      <Stack.Screen name="search" options={{ title: 'Search' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}

/** CHAT-074: a call takes over the audio, so a voice message playing stops when one starts. */
function VoiceCallGuard() {
  // CHAT-075: this phone's call settings, read when a call starts.
  useEffect(() => {
    void loadCallPrefs();
  }, []);
  const call = useCalls().call;
  const groupSession = useGroupCall().session;
  const inCall = !!call || !!groupSession;
  useEffect(() => {
    if (inCall) voicePlayback.stop();
  }, [inCall]);
  return null;
}

export default function AppLayout() {
  return (
    <DataProvider>
      <RealtimeProvider>
        <PushProvider>
          <CallProvider>
            <GroupCallProvider>
              <View style={{ flex: 1 }}>
                <VoiceCallGuard />
                <ThemedStack />
                <CallOverlay />
              </View>
            </GroupCallProvider>
          </CallProvider>
        </PushProvider>
      </RealtimeProvider>
    </DataProvider>
  );
}

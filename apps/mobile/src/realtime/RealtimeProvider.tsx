import NetInfo from '@react-native-community/netinfo';
import { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { isCallActive, subscribeCallActive } from '../calls/activity';
import { session } from '../lib/api';
import { createRealtimeController } from './controller';
import { realtimeClient, setEventHandler } from './connection';
import { applyRealtimeEvent, catchUp, resetInboxThrottle } from './events';
import { resetTyping } from './typing';

/**
 * CHAT-054: keeps the live socket in step with the app's state. It is open while the person is
 * signed in, online and in the app (plus 30 s after leaving it), applies what arrives to the
 * caches the screens read, and catches up the moment the app comes back or the socket reconnects.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.status === 'signedIn' ? state.user.id : null;

  useEffect(() => {
    if (!userId) return;
    const generation = session.generation();
    setEventHandler((envelope) => {
      if (envelope.type === 'realtime.ready') catchUp();
      applyRealtimeEvent(envelope, { myId: userId, generation });
    });
    const controller = createRealtimeController({ target: realtimeClient, onResume: catchUp });
    controller.setActive(AppState.currentState === 'active');
    const appSub = AppState.addEventListener('change', (s) => controller.setActive(s === 'active'));
    const netUnsub = NetInfo.addEventListener((s) => controller.setOnline(s.isConnected !== false));
    controller.setInCall(isCallActive());
    const callUnsub = subscribeCallActive((active) => controller.setInCall(active));
    controller.setSignedIn(true);
    return () => {
      callUnsub();
      appSub.remove();
      netUnsub();
      controller.dispose();
      setEventHandler(null);
      realtimeClient.close();
      resetTyping();
      resetInboxThrottle();
    };
  }, [userId]);

  return <>{children}</>;
}

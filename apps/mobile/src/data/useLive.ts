import { useIsFocused } from 'expo-router';
import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useRealtimeStatus } from '../realtime/status';

/** True while the app is in the foreground. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/**
 * Polling interval for a screen's queries: `ms` while the screen is showing and the app is in the
 * foreground, off otherwise. While the live socket is connected (CHAT-054) the socket delivers the
 * updates, so polling only stays as a slow safety net (`whileLiveMs`).
 */
export function useLiveInterval(ms: number, whileLiveMs: number = ms): number | false {
  const focused = useIsFocused();
  const active = useAppActive();
  const live = useRealtimeStatus() === 'open';
  return focused && active ? (live ? whileLiveMs : ms) : false;
}

/** Whether the device reports a usable connection (unknown counts as online). */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((s) => setOnline(s.isConnected !== false));
    return unsubscribe;
  }, []);
  return online;
}

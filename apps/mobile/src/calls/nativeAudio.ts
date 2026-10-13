import {
  addAudioRouteChangedListener,
  getAudioSession,
  setAudioSessionPortOverride,
  setRTCAudioSessionConfiguration,
} from 'expo-callkit-telecom';
import { PermissionsAndroid, Platform } from 'react-native';
import { RouteTracker, type AudioDriver } from './audioRoute';

const ROUTE_READBACK_MS = 400;

/**
 * CHAT-061/062: the audio driver on top of the native call library, which owns the system call
 * audio (CallKit / Telecom). It routes to a connected headset or Bluetooth device by itself;
 * what we add is the loudspeaker switch, and we report which route is in use.
 */
let refresh: (() => void) | null = null;

export const nativeAudioDriver: AudioDriver = {
  start(media) {
    // iOS: the WebRTC audio session is driven by CallKit, not by WebRTC itself.
    if (Platform.OS === 'ios') setRTCAudioSessionConfiguration(media === 'video');
  },
  stop() {
    // The library restores the audio session when the call session ends.
  },
  choose(route) {
    // The speaker is the only route we can force; every other choice is "the system's own pick"
    // (earpiece, or a headset / Bluetooth device when one is connected).
    setAudioSessionPortOverride(route === 'speaker');
    // The system may not have done what was asked (earpiece while a headset is connected): read
    // back where the sound really is, so the route button never claims otherwise.
    setTimeout(() => refresh?.(), ROUTE_READBACK_MS);
  },
  watch(listener) {
    const tracker = new RouteTracker();
    const read = () => {
      try {
        listener(tracker.update(getAudioSession()));
      } catch {
        // No call session yet: the first route event reports it.
      }
    };
    read();
    refresh = read;
    const subscription = addAudioRouteChangedListener((event) => listener(tracker.update(event)));
    return () => {
      refresh = null;
      subscription.remove();
    };
  },
};

/**
 * Android 12+ only lets an app see a paired Bluetooth headset once it holds BLUETOOTH_CONNECT.
 * Asked once per call setup; a refusal just means Bluetooth routing is off.
 */
export async function requestBluetoothPermission(): Promise<void> {
  if (Platform.OS !== 'android' || Platform.Version < 31) return;
  const permission = 'android.permission.BLUETOOTH_CONNECT' as const;
  try {
    if (!(await PermissionsAndroid.check(permission))) await PermissionsAndroid.request(permission);
  } catch {
    // Bluetooth routing is a nicety; never block a call on it.
  }
}

import { DeviceEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { NATIVE_ROUTE, parseDeviceStatus, type AudioDriver } from './audioRoute';

/**
 * CHAT-062: the audio driver on top of react-native-incall-manager. On Android its audio manager
 * picks the route (earpiece/speaker/wired/Bluetooth), reports every change, and turns the screen
 * off against the ear while the sound is on the earpiece. On iOS the system routes to a connected
 * headset or Bluetooth device itself; only speaker vs. phone is ours to set.
 */
export const nativeAudioDriver: AudioDriver = {
  start(media) {
    InCallManager.start({ media });
  },
  stop() {
    InCallManager.stop();
  },
  choose(route) {
    if (Platform.OS === 'android') {
      void InCallManager.chooseAudioRoute(NATIVE_ROUTE[route]).catch(() => undefined);
    } else {
      InCallManager.setForceSpeakerphoneOn(route === 'speaker');
    }
  },
  watch(listener) {
    if (Platform.OS !== 'android') {
      // iOS reports no devices: offer the phone and the speaker.
      listener({ available: ['earpiece', 'speaker'], selected: null });
      return () => undefined;
    }
    const subscription = DeviceEventEmitter.addListener('onAudioDeviceChanged', (event) =>
      listener(parseDeviceStatus(event)),
    );
    return () => subscription.remove();
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

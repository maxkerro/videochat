import ExpoPip from 'expo-pip';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** The picture-in-picture window is portrait, like the other person's camera. */
const PIP_SIZE = { width: 9, height: 16 } as const;

const isAndroid = Platform.OS === 'android';

function safely<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

/** Android picture-in-picture (react-native-webrtc's RTCPIPView covers iOS). */
export const pip = {
  /** The phone and its Android version can do picture-in-picture. */
  isAvailable: () => isAndroid && safely(() => ExpoPip.isAvailable(), false),

  /** With `on`, leaving the app (Home, recents, another app) shrinks the call into the window. */
  setAutoEnter(on: boolean): void {
    if (!isAndroid) return;
    safely(
      () => ExpoPip.setPictureInPictureParams({ ...PIP_SIZE, autoEnterEnabled: on }),
      undefined,
    );
  },

  enter(): void {
    if (!isAndroid) return;
    safely(() => ExpoPip.enterPipMode({ ...PIP_SIZE }), undefined);
  },
};

/** True while the app is shown in the small window. */
export function useIsInPip(): boolean {
  const [inPip, setInPip] = useState(false);
  useEffect(() => {
    if (!isAndroid) return;
    const subscription = safely(
      () => ExpoPip.addEventListener('onPipModeChange', (e) => setInPip(e.isInPipMode)),
      null,
    );
    return () => subscription?.remove();
  }, []);
  return inPip;
}

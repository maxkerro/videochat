import { requireOptionalNativeModule } from 'expo';

interface ProximityScreenNative {
  isSupported(): boolean;
  setEnabled(enabled: boolean): void | Promise<void>;
}

/**
 * CHAT-083: screen off against the ear. Missing in Expo Go, tests and APKs built before this
 * module existed: then it does nothing (the old behaviour).
 */
const native = requireOptionalNativeModule<ProximityScreenNative>('ProximityScreen');

export const proximityScreen = {
  isAvailable: (): boolean => {
    try {
      return native?.isSupported() ?? false;
    } catch {
      return false;
    }
  },
  setEnabled: (enabled: boolean): void => {
    try {
      void native?.setEnabled(enabled);
    } catch {
      // A missing sensor is not worth failing a call over.
    }
  },
};

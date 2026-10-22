import { requireOptionalNativeModule } from 'expo';

interface Subscription {
  remove(): void;
}

interface VideoBlurNative {
  isSupported(): boolean;
  processorName(): string;
  addListener(event: 'onStats', listener: (e: { frameMs: number }) => void): Subscription;
}

/**
 * CHAT-084: background blur for the camera, as a react-native-webrtc frame processor. Missing in
 * Expo Go, tests and APKs built before this module existed: then blur is simply not offered.
 */
const native = requireOptionalNativeModule<VideoBlurNative>('VideoBlur');

export const videoBlur = {
  isAvailable: (): boolean => {
    try {
      return native?.isSupported() ?? false;
    } catch {
      return false;
    }
  },
  /** The effect name to pass to `track._setVideoEffects`. */
  processorName: (): string => {
    try {
      return native?.processorName() ?? 'videochat-blur';
    } catch {
      return 'videochat-blur';
    }
  },
  /** Average time per blurred frame (ms), about once a second while blur runs. */
  addStatsListener: (listener: (frameMs: number) => void): Subscription => {
    if (!native) return { remove: () => undefined };
    try {
      return native.addListener('onStats', (e) => listener(e.frameMs));
    } catch {
      return { remove: () => undefined };
    }
  },
};

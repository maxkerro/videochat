import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * CHAT-075: call settings kept on this phone (not the account): noise suppression, on unless
 * switched off. Read synchronously when a call starts; loaded once at launch.
 */
const KEY = 'call_noise_suppression';
let noise = true;
const listeners = new Set<() => void>();

export async function loadCallPrefs(): Promise<void> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    if (stored !== null) setLocal(stored !== 'off');
  } catch {
    // unreadable: keep the default
  }
}

export function noiseSuppressionOn(): boolean {
  return noise;
}

export async function setNoiseSuppression(on: boolean): Promise<void> {
  setLocal(on);
  await SecureStore.setItemAsync(KEY, on ? 'on' : 'off').catch(() => undefined);
}

function setLocal(on: boolean) {
  noise = on;
  for (const l of listeners) l();
}

export function useNoiseSuppression(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => noise,
  );
}

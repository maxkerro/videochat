import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * CHAT-075/084: call settings kept on this phone (not the account): noise suppression (on unless
 * switched off) and background blur (off unless switched on). Read synchronously when a call
 * starts; loaded once at launch.
 */
const NOISE_KEY = 'call_noise_suppression';
const BLUR_KEY = 'call_background_blur';
let noise = true;
let blur = false;
const listeners = new Set<() => void>();

export async function loadCallPrefs(): Promise<void> {
  try {
    const [storedNoise, storedBlur] = await Promise.all([
      SecureStore.getItemAsync(NOISE_KEY),
      SecureStore.getItemAsync(BLUR_KEY),
    ]);
    if (storedNoise !== null) noise = storedNoise !== 'off';
    if (storedBlur !== null) blur = storedBlur === 'on';
    notify();
  } catch {
    // unreadable: keep the defaults
  }
}

export function noiseSuppressionOn(): boolean {
  return noise;
}

export function backgroundBlurOn(): boolean {
  return blur;
}

export async function setNoiseSuppression(on: boolean): Promise<void> {
  noise = on;
  notify();
  await SecureStore.setItemAsync(NOISE_KEY, on ? 'on' : 'off').catch(() => undefined);
}

export async function setBackgroundBlur(on: boolean): Promise<void> {
  blur = on;
  notify();
  await SecureStore.setItemAsync(BLUR_KEY, on ? 'on' : 'off').catch(() => undefined);
}

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useNoiseSuppression(): boolean {
  return useSyncExternalStore(subscribe, () => noise);
}

export function useBackgroundBlurPref(): boolean {
  return useSyncExternalStore(subscribe, () => blur);
}

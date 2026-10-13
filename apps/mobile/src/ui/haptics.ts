import * as Haptics from 'expo-haptics';

/*
 * CHAT-057: small physical confirmations. Never worth an error: a phone without a haptic engine, or
 * with haptics switched off, simply does nothing.
 */
const ignore = () => undefined;

/** A light tick: a swipe reached its trigger point, a menu opened. */
export function tick(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore);
}

/** A selection change: choosing a reaction. */
export function select(): void {
  void Haptics.selectionAsync().catch(ignore);
}

/** Something was done (copied, reported). */
export function success(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore);
}

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getViewing } from '../realtime/connection';

/** Must match ANDROID_CHANNEL / ANDROID_CHANNEL_SILENT in the API's FcmPushChannel. */
export const CHANNEL_MESSAGES = 'messages';
export const CHANNEL_SILENT = 'messages-silent';

let configured = false;

/** One-time setup: how a notification that arrives while the app is open is shown, and the Android
 *  channels the server's pushes name. */
export async function configureNotifications(): Promise<void> {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data as { conversationId?: unknown } | undefined;
      // The conversation on screen already shows its new messages.
      const hidden = data?.conversationId !== undefined && data.conversationId === getViewing();
      return {
        shouldShowBanner: !hidden,
        shouldShowList: !hidden,
        shouldPlaySound: !hidden,
        shouldSetBadge: false,
      };
    },
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_MESSAGES, {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 100, 200],
    });
    await Notifications.setNotificationChannelAsync(CHANNEL_SILENT, {
      name: 'Messages (silent)',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: null,
      vibrationPattern: null,
    });
  }
}

/** Asks for permission the first time (Android 13+ shows a dialog); true when granted. */
export async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Removes the notifications still in the tray for a conversation the person just opened. */
export async function dismissConversationNotifications(conversationId: string): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      shown
        .filter((n) => n.request.content.data?.conversationId === conversationId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
    );
  } catch {
    // nothing to dismiss, or the platform can't list them
  }
}

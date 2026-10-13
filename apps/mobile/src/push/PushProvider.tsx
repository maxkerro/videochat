import { useQueryClient } from '@tanstack/react-query';
import type { ConversationSummary } from '@videochat/shared';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { keys } from '../data/keys';
import { configureNotifications, ensurePermission } from './notifications';
import { routeForNotification, totalUnread } from './payload';
import { registerToken, forgetRegistration } from './registration';

/** The last notification tap acted on. Module-level: it must survive this provider remounting
 * (sign-out/in), or the same stale tap would navigate again. */
let handledNotificationId: string | null = null;

/**
 * CHAT-055: push notifications on the phone. After sign-in it asks for permission (once), registers
 * the device's FCM token with the API (and again whenever the token rotates), opens the right
 * conversation when a notification is tapped -- also when that tap launched the app -- and keeps
 * the icon badge equal to the unread count.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.status === 'signedIn' ? state.user.id : null;
  const router = useRouter();
  const queryClient = useQueryClient();

  // Registration -------------------------------------------------------------------------------
  useEffect(() => {
    if (!userId || Platform.OS === 'web') return;
    let cancelled = false;
    forgetRegistration(); // a different account may have signed in on this phone
    const register = async (token: string) => {
      if (cancelled) return;
      // The API's channel serves Android; an iOS token is stored for when APNs is added.
      await registerToken(Platform.OS === 'ios' ? 'ios' : 'android', token);
    };
    void (async () => {
      try {
        await configureNotifications();
        if (!(await ensurePermission()) || cancelled) return;
        const token = await Notifications.getDevicePushTokenAsync();
        if (typeof token.data === 'string') await register(token.data);
      } catch {
        // No Google services / offline: push is optional; the next launch tries again.
      }
    })();
    const sub = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string') void register(token.data).catch(() => undefined);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [userId]);

  // Tapping a notification ---------------------------------------------------------------------
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!userId || !last) return;
    if (last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = last.notification.request.identifier;
    if (handledNotificationId === id) return;
    handledNotificationId = id;
    const route = routeForNotification(last.notification.request.content.data);
    if (route) router.push(route);
  }, [userId, last, router]);

  // Badge --------------------------------------------------------------------------------------
  useEffect(() => {
    if (!userId) {
      void Notifications.setBadgeCountAsync(0).catch(() => undefined);
      return;
    }
    const update = () => {
      const list = queryClient.getQueryData<ConversationSummary[]>(keys.conversations);
      if (list) void Notifications.setBadgeCountAsync(totalUnread(list)).catch(() => undefined);
    };
    update();
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === keys.conversations[0]) update();
    });
  }, [userId, queryClient]);

  return <>{children}</>;
}

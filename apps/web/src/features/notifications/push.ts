import { vapidKeySchema } from '@videochat/shared';
import { z } from 'zod';
import { apiDelete, apiGet, apiPost } from '../../lib/api';

const ASKED_KEY = 'videochat.pushAsked';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Registers the service worker (no permission prompt -- that only comes after a first send). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function subscribe(accessToken: string): Promise<boolean> {
  const { publicKey } = await apiGet('/push/vapid-public-key', vapidKeySchema);
  if (!publicKey) return false; // Push is switched off on this server.
  const registration = (await registerServiceWorker()) ?? null;
  if (!registration) return false;
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return false;
  await apiPost(
    '/push/subscriptions',
    z.unknown(),
    { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return true;
}

/**
 * CHAT-035 AC: permission is asked after the person's first sent message, never on page load.
 * Called from the send handler (a user gesture, which browsers require for the prompt); asks at
 * most once per browser.
 */
export async function askForPushAfterFirstSend(accessToken: string): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'default') return;
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // No storage: still only asks while permission is 'default'.
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') await subscribe(accessToken).catch(() => false);
}

/** On sign-in: keeps an already-granted subscription registered to whoever is signed in now. */
export async function syncPushSubscription(accessToken: string): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') return;
  await subscribe(accessToken).catch(() => false);
}

/** On sign-out: this browser shouldn't keep getting the signed-out person's notifications. */
export async function removePushSubscription(accessToken: string): Promise<void> {
  if (!isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await apiDelete('/push/subscriptions', z.unknown(), {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  } catch {
    // Best effort.
  }
}

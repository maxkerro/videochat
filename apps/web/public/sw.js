/* global self, URL */
/* CHAT-035: service worker -- shows push notifications and opens the right conversation. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  event.waitUntil(
    (async () => {
      // The server already skips the conversation a tab is showing; this covers the race where
      // the person opened it just as the push was sent.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const viewing = windows.some(
        (c) => c.visibilityState === 'visible' && c.focused && new URL(c.url).pathname === url,
      );
      if (viewing) return;
      await self.registration.showNotification(data.title || 'New message', {
        body: data.body || '',
        tag: data.tag || url,
        renotify: true,
        silent: data.silent === true,
        icon: '/favicon.svg',
        data: { url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        // The app routes client-side; ask it to go there rather than reloading the page.
        existing.postMessage({ type: 'navigate', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

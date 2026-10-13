import type { Presence } from '@videochat/shared';

/** "Online", "Last seen just now", "Last seen 5 min ago", "Last seen today at 14:05", ... */
export function presenceLabel(presence: Presence | undefined, now = Date.now()): string | null {
  if (!presence) return null;
  if (presence.online) return 'Online';
  if (!presence.lastSeenAt) return null;
  const at = new Date(presence.lastSeenAt);
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return 'Last seen just now';
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (at.toDateString() === today.toDateString()) return `Last seen today at ${time}`;
  if (at.toDateString() === yesterday.toDateString()) return `Last seen yesterday at ${time}`;
  return `Last seen ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

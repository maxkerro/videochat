import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  presenceListSchema,
  presenceSchema,
  type Presence,
  type WsEnvelope,
} from '@videochat/shared';
import { useMemo } from 'react';
import { apiGet } from '../../lib/api';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useRealtimeEvent } from '../chat/RealtimeProvider';

export function fetchPresence(accessToken: string, userIds: string[]): Promise<Presence[]> {
  return apiGet(
    `/presence?userIds=${userIds.map(encodeURIComponent).join(',')}`,
    presenceListSchema,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
}

/**
 * CHAT-034: presence for these people, kept live by `presence.changed` events. People the server
 * won't show (privacy, or no shared conversation) are simply absent from the map.
 */
export function usePresence(userIds: string[]): Map<string, Presence> {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const ids = useMemo(() => [...new Set(userIds)].sort(), [userIds]);
  const query = useQuery({
    queryKey: ['presence', ids],
    queryFn: () => withAuthRetry(auth, (token) => fetchPresence(token, ids)),
    enabled: ids.length > 0 && !!auth.accessToken,
    // A backstop for a missed event (e.g. while the socket was reconnecting).
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'presence.changed') return;
    const parsed = presenceSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const next = parsed.data;
    queryClient.setQueriesData<Presence[]>({ queryKey: ['presence'] }, (list) => {
      if (!list || !list.some((p) => p.userId === next.userId)) return list;
      return list.map((p) => (p.userId === next.userId ? next : p));
    });
  });

  return useMemo(() => new Map((query.data ?? []).map((p) => [p.userId, p])), [query.data]);
}

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

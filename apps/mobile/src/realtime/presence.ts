import { useQuery } from '@tanstack/react-query';
import { presenceListSchema, type Presence } from '@videochat/shared';
import { useMemo } from 'react';
import { apiGet } from '../lib/api';
import { useLiveInterval } from '../data/useLive';

export function fetchPresence(userIds: string[]): Promise<Presence[]> {
  return apiGet(
    `/presence?userIds=${userIds.map(encodeURIComponent).join(',')}`,
    presenceListSchema,
  );
}

/**
 * CHAT-034 on the phone: presence for these people, kept live by `presence.changed` events (see
 * events.ts). People the server won't show (their privacy setting) are simply absent.
 */
export function usePresence(userIds: string[]): Map<string, Presence> {
  const ids = useMemo(() => [...new Set(userIds)].sort(), [userIds]);
  const refetchInterval = useLiveInterval(60_000);
  const query = useQuery({
    queryKey: ['presence', ids],
    queryFn: () => fetchPresence(ids),
    enabled: ids.length > 0,
    // A backstop for an event missed while the socket was away.
    refetchInterval,
    staleTime: 30_000,
  });
  return useMemo(() => new Map((query.data ?? []).map((p) => [p.userId, p])), [query.data]);
}

export { presenceLabel } from './presenceLabel';

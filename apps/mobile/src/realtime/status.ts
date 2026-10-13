import { useSyncExternalStore } from 'react';
import type { RealtimeStatus } from './client';

let status: RealtimeStatus = 'closed';
const listeners = new Set<() => void>();

export function setRealtimeStatus(next: RealtimeStatus): void {
  if (next === status) return;
  status = next;
  for (const l of listeners) l();
}

export const getRealtimeStatus = () => status;

/** Whether the live socket is connected right now (CHAT-054). While it is, screens poll far less. */
export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}

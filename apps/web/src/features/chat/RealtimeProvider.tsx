import type { WsEnvelope } from '@videochat/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { RealtimeClient } from '../../lib/realtime';
import { useAuth } from '../auth/AuthContext';

type EventListener = (envelope: WsEnvelope) => void;

interface RealtimeContextValue {
  subscribe: (listener: EventListener) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

interface RealtimeSingleton {
  setToken: (token: string | null) => void;
  client: RealtimeClient;
  context: RealtimeContextValue;
}

/** Built once per provider instance (inside `useState`'s lazy initializer, so it never rebuilds
 *  on re-render): the client, its listener set and the token it authenticates with are plain
 *  closure state here, not React refs, since nothing about them needs render-time reactivity. */
function createRealtimeSingleton(): RealtimeSingleton {
  let token: string | null = null;
  const listeners = new Set<EventListener>();
  const client = new RealtimeClient({
    getAccessToken: () => token,
    onEvent: (envelope) => {
      for (const listener of listeners) listener(envelope);
    },
  });
  return {
    setToken: (next) => {
      token = next;
    },
    client,
    context: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/**
 * CHAT-013: one realtime connection for the whole app, reused by every open conversation. Held
 * here rather than per-`ChatPane` so switching conversations doesn't reconnect the socket.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [singleton] = useState(createRealtimeSingleton);

  useEffect(() => {
    singleton.setToken(auth.accessToken);
  }, [singleton, auth.accessToken]);

  useEffect(() => {
    if (auth.status === 'authenticated') {
      singleton.client.connect();
    } else {
      singleton.client.disconnect();
    }
  }, [singleton, auth.status]);
  // Only ever tears down on unmount, not on every status flip (the effect above already
  // connects/disconnects for that) -- otherwise a status change would disconnect twice.
  useEffect(() => () => singleton.client.disconnect(), [singleton]);

  return <RealtimeContext.Provider value={singleton.context}>{children}</RealtimeContext.Provider>;
}

/** Calls `handler` for every realtime event received while mounted. `handler` is read fresh on
 *  each call, so callers don't need to memoize it. */
export function useRealtimeEvent(handler: EventListener): void {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtimeEvent must be used inside <RealtimeProvider>');
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => ctx.subscribe((envelope) => handlerRef.current(envelope)), [ctx]);
}

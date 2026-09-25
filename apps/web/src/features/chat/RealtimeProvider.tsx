import { useQueryClient } from '@tanstack/react-query';
import { makeEnvelope, type TypingSignalInput, type WsEnvelope } from '@videochat/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { RealtimeClient, type RealtimeStatus } from '../../lib/realtime';
import { getLastSeenSeq, recordSeenSeq, trackedConversationIds } from '../../lib/lastSeenSeq';
import { listAllQueuedMessages, removeOutboxMessage } from '../../lib/outbox';
import { useAuth, withAuthRetry, type AuthContextValue } from '../auth/AuthContext';
import { appendToLatestPage, type MessagesData } from './messagesCache';
import { fetchMessagesAfter, sendMessage } from './messagesApi';
import { runGapSync } from './gapSync';
import { flushOutbox } from './outboxFlush';

type EventListener = (envelope: WsEnvelope) => void;
type StatusListener = (status: RealtimeStatus) => void;

interface RealtimeContextValue {
  subscribe: (listener: EventListener) => () => void;
  subscribeStatus: (listener: StatusListener) => () => void;
  getStatus: () => RealtimeStatus;
  /** CHAT-020: sends a "I'm typing in this conversation" signal over the socket. Best-effort and
   *  a no-op while disconnected -- see `RealtimeClient.send`. */
  sendTyping: (conversationId: string) => void;
}

let envelopeIdCounter = 0;
/** A cheap, locally-unique-enough id for an outgoing envelope -- unlike a message's own
 *  `clientMsgId`, nothing server-side ever dedupes on this, so it doesn't need to be a real UUID. */
function nextEnvelopeId(): string {
  envelopeIdCounter += 1;
  return `typing-${Date.now()}-${envelopeIdCounter}`;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

interface RealtimeSingleton {
  setToken: (token: string | null) => void;
  client: RealtimeClient;
  context: RealtimeContextValue;
}

/** Built once per provider instance (inside `useState`'s lazy initializer, so it never rebuilds
 *  on re-render): the client, its listener sets and the token it authenticates with are plain
 *  closure state here, not React refs, since nothing about them needs render-time reactivity. */
function createRealtimeSingleton(): RealtimeSingleton {
  let token: string | null = null;
  let status: RealtimeStatus = 'closed';
  const listeners = new Set<EventListener>();
  const statusListeners = new Set<StatusListener>();
  const client = new RealtimeClient({
    getAccessToken: () => token,
    onEvent: (envelope) => {
      for (const listener of listeners) listener(envelope);
    },
    onStatusChange: (next) => {
      status = next;
      for (const listener of statusListeners) listener(next);
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
      subscribeStatus: (listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      getStatus: () => status,
      sendTyping: (conversationId) => {
        client.send(
          makeEnvelope<TypingSignalInput>(
            'conversation.typing',
            { conversationId },
            nextEnvelopeId(),
          ),
        );
      },
    },
  };
}

/** CHAT-017: catches this tab up on everything it missed while disconnected -- messages sent to
 *  the person's tracked conversations (gap sync) and messages the person typed while offline
 *  (the outbox) -- merging both into the query cache exactly like a live `message.new` event, so
 *  every open view updates without a page reload. Runs once per transition to `open`, including
 *  the very first connect (in case the tab was closed, not just disconnected, while messages or
 *  outbox entries piled up), and is safe to call again on a later reconnect since gap sync just
 *  reports nothing missed and a drained outbox is a no-op. */
async function catchUp(
  auth: Pick<AuthContextValue, 'accessToken' | 'refresh'>,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await runGapSync({
    trackedConversationIds,
    getLastSeenSeq,
    recordSeenSeq,
    fetchAfter: (conversationId, afterSeq) =>
      withAuthRetry(auth, (token) => fetchMessagesAfter(token, conversationId, afterSeq)),
    onCaughtUp: (conversationId, messages) => {
      for (const message of messages) {
        queryClient.setQueryData<MessagesData>(['messages', conversationId], (old) =>
          appendToLatestPage(old, message),
        );
      }
      // Unread counts and previews live in the conversation list, keyed off the same messages --
      // refetch it too so a chat that was caught up while closed still shows as unread/updated.
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  await flushOutbox({
    listQueued: listAllQueuedMessages,
    send: (conversationId, clientMsgId, body) =>
      withAuthRetry(auth, (token) => sendMessage(token, conversationId, { clientMsgId, body })),
    remove: removeOutboxMessage,
    onSent: (message) => {
      queryClient.setQueryData<MessagesData>(['messages', message.conversationId], (old) =>
        appendToLatestPage(old, message),
      );
    },
  });
}

/**
 * CHAT-013: one realtime connection for the whole app, reused by every open conversation. Held
 * here rather than per-`ChatPane` so switching conversations doesn't reconnect the socket.
 *
 * CHAT-017 extends it with reconnect handling: every transition to `open` triggers gap sync and
 * an outbox flush (see `catchUp` above), and `useRealtimeStatus` lets the UI show a "Connecting…"
 * banner while the socket isn't `open`.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [singleton] = useState(createRealtimeSingleton);
  // Guards against overlapping catch-ups if `open` fires again (e.g. a brief flap) before the
  // previous one finished -- a second run would at worst redo harmless idempotent work, but
  // there's no reason to let two run concurrently.
  const catchingUpRef = useRef(false);

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

  useEffect(
    () =>
      singleton.context.subscribeStatus((status) => {
        if (status !== 'open' || catchingUpRef.current) return;
        catchingUpRef.current = true;
        void catchUp(auth, queryClient).finally(() => {
          catchingUpRef.current = false;
        });
      }),
    // `auth` and `queryClient` are stable references from their own providers for the lifetime of
    // the app, so this only ever needs to (re-)subscribe when the singleton itself changes (never,
    // in practice -- it's created once).
    [singleton, auth, queryClient],
  );

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

/** CHAT-020: sends a typing signal for `conversationId` over the shared socket. */
export function useSendTyping(): (conversationId: string) => void {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useSendTyping must be used inside <RealtimeProvider>');
  return ctx.sendTyping;
}

/** CHAT-017: the realtime connection's current status, kept in sync as it changes -- for the
 *  "Connecting…" banner (or any other UI that cares whether live delivery is currently working). */
export function useRealtimeStatus(): RealtimeStatus {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtimeStatus must be used inside <RealtimeProvider>');
  const [status, setStatus] = useState(ctx.getStatus);
  useEffect(() => ctx.subscribeStatus(setStatus), [ctx]);
  return status;
}

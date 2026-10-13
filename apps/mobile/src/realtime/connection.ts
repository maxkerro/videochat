import {
  makeEnvelope,
  realtimeReadySchema,
  type TypingSignalInput,
  type WsEnvelope,
} from '@videochat/shared';
import { config, session } from '../lib/api';
import { RealtimeClient } from './client';
import { setRealtimeStatus } from './status';
import type { RealtimeStatus } from './client';

let envelopeCounter = 0;
const nextId = () => `m-${Date.now().toString(36)}-${(envelopeCounter += 1)}`;

type Handler = (envelope: WsEnvelope) => void;
let handler: Handler | null = null;
let viewing: string | null = null;
let connectionId: string | null = null;
const subscribers = new Set<Handler>();

/** The one socket of the app. The provider decides when it exists (see controller.ts). */
export const realtimeClient = new RealtimeClient({
  url: config.realtimeUrl,
  getAccessToken: async () => (session.isSignedIn() ? await session.getAccessToken() : null),
  onStatus: (status: RealtimeStatus) => {
    // The id belongs to one socket; none until the server confirms the next one.
    if (status !== 'open') connectionId = null;
    setRealtimeStatus(status);
  },
  onEvent: (envelope) => {
    if (envelope.type === 'realtime.ready') {
      const ready = realtimeReadySchema.safeParse(envelope.payload);
      connectionId = ready.success ? ready.data.connectionId : null;
      sendViewing();
    }
    handler?.(envelope);
    for (const subscriber of subscribers) subscriber(envelope);
  },
});

export function setEventHandler(next: Handler | null): void {
  handler = next;
}

/** CHAT-060: a second listener for the same events (calls), independent of the one that feeds the
 *  caches. Returns the unsubscribe function. */
export function subscribeRealtime(listener: Handler): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** This socket's id as the server knows it (to tell my own answer from another device's). */
export const getConnectionId = () => connectionId;

/** Resolves true once the socket is open and registered with the server (it has a connection id),
 *  false if that takes longer than `timeoutMs`. A call answered from the lock screen starts the
 *  app before the socket is up. */
export function waitForRealtime(timeoutMs: number): Promise<boolean> {
  if (connectionId !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = subscribeRealtime((envelope) => {
      if (envelope.type === 'realtime.ready' && connectionId !== null) finish(true);
    });
  });
}

/** Sends one event; false when the socket is not open. */
export function sendRealtimeEvent(type: string, payload: unknown): boolean {
  return realtimeClient.send(makeEnvelope(type, payload, nextId()));
}

function sendViewing(): void {
  // Tells the server what is on screen so it doesn't push a notification for it (CHAT-035).
  realtimeClient.send(makeEnvelope('client.viewing', { conversationId: viewing }, nextId()));
}

export const getViewing = () => viewing;

/** The conversation being looked at (or null). Re-sent on every reconnect. */
export function reportViewing(conversationId: string | null): void {
  viewing = conversationId;
  sendViewing();
}

export function sendTypingSignal(conversationId: string): void {
  realtimeClient.send(
    makeEnvelope<TypingSignalInput>('conversation.typing', { conversationId }, nextId()),
  );
}

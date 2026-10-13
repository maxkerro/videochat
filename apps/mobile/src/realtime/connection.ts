import { makeEnvelope, type TypingSignalInput, type WsEnvelope } from '@videochat/shared';
import { config, session } from '../lib/api';
import { RealtimeClient } from './client';
import { setRealtimeStatus } from './status';

let envelopeCounter = 0;
const nextId = () => `m-${Date.now().toString(36)}-${(envelopeCounter += 1)}`;

type Handler = (envelope: WsEnvelope) => void;
let handler: Handler | null = null;
let viewing: string | null = null;

/** The one socket of the app. The provider decides when it exists (see controller.ts). */
export const realtimeClient = new RealtimeClient({
  url: config.realtimeUrl,
  getAccessToken: async () => (session.isSignedIn() ? await session.getAccessToken() : null),
  onStatus: setRealtimeStatus,
  onEvent: (envelope) => {
    if (envelope.type === 'realtime.ready') sendViewing();
    handler?.(envelope);
  },
});

export function setEventHandler(next: Handler | null): void {
  handler = next;
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

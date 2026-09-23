import { z } from 'zod';

/**
 * Versioned WebSocket envelope. Every realtime event (server→client and client→server)
 * travels in this shape; `payload` is validated per `type` by the handler.
 * Used from M1 (CHAT-013) onward; defined now so clients and server agree from day one.
 */
export const REALTIME_PROTOCOL_VERSION = 1;

export const wsEnvelopeSchema = z.object({
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(64),
  ts: z.iso.datetime(),
  payload: z.unknown(),
});
export type WsEnvelope<T = unknown> = Omit<z.infer<typeof wsEnvelopeSchema>, 'payload'> & {
  payload: T;
};

export function makeEnvelope<T>(type: string, payload: T, id: string): WsEnvelope<T> {
  return { v: REALTIME_PROTOCOL_VERSION, type, id, ts: new Date().toISOString(), payload };
}

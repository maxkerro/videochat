import { z } from 'zod';

/**
 * CHAT-040: one entry of `RTCConfiguration.iceServers`, exactly as the browser's
 * `RTCPeerConnection` expects it, so the client can pass the server's response straight through.
 * STUN entries carry only `urls`; TURN entries also carry short-lived `username`/`credential`.
 */
export const iceServerSchema = z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

/** CHAT-040: `GET /calls/ice-servers`. `ttlSeconds` is how long any TURN credential in the list
 *  stays valid -- the client should fetch a fresh list for each call rather than caching it. */
export const iceServersResponseSchema = z.object({
  iceServers: z.array(iceServerSchema),
  ttlSeconds: z.number().int().positive(),
});
export type IceServersResponse = z.infer<typeof iceServersResponseSchema>;

import { z } from 'zod';
import { CALL_END_REASONS, CALL_MEDIA } from './domain.js';

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

// ---------------------------------------------------------------------------------------------
// CHAT-041: call signalling over the realtime WebSocket. Every event travels in the ordinary
// `WsEnvelope`; `type` is one of `CALL_EVENTS` and `payload` matches the schema named after it.
//
// Lifecycle events (incoming/ringing/accepted/ended) go to *every* device of both participants,
// so all of a callee's devices ring and all stop the moment one answers. Media negotiation
// (offer/answer/ice/media) goes only to the one connection actually in the call on the other
// side: the caller's connection that placed it and the callee's connection that answered.
// ---------------------------------------------------------------------------------------------

export const CALL_EVENTS = {
  /** client -> server: start a call in a direct conversation. */
  invite: 'call.invite',
  /** server -> callee devices: someone is calling. */
  incoming: 'call.incoming',
  /** callee device -> server -> caller: at least one device is ringing. */
  ringing: 'call.ringing',
  /** callee device -> server: answer. */
  accept: 'call.accept',
  /** server -> both users: answered, by the device with this `connectionId`. */
  accepted: 'call.accepted',
  /** callee device -> server: reject. */
  decline: 'call.decline',
  /** caller -> server: hang up before it was answered. */
  cancel: 'call.cancel',
  /** either participant -> server: hang up an answered call. */
  end: 'call.end',
  /** server -> both users: the call is over, with a reason. */
  ended: 'call.ended',
  /** WebRTC negotiation, relayed between the two connections in the call. */
  offer: 'call.offer',
  answer: 'call.answer',
  ice: 'call.ice',
  /** Mute/camera state, relayed so each side can show the other's (CHAT-042). */
  media: 'call.media',
  /** A participant's socket reconnected mid-call and is re-attaching to it (CHAT-043). */
  resume: 'call.resume',
} as const;

const callId = z.uuid();

export const callInviteSchema = z.object({
  callId,
  conversationId: z.uuid(),
  media: z.enum(CALL_MEDIA),
});
export type CallInvite = z.infer<typeof callInviteSchema>;

/** Payload of ringing/accept/decline/cancel/end/resume from a client: just which call. */
export const callRefSchema = z.object({ callId });
export type CallRef = z.infer<typeof callRefSchema>;

export const callIncomingSchema = z.object({
  callId,
  conversationId: z.uuid(),
  media: z.enum(CALL_MEDIA),
  caller: z.object({
    id: z.uuid(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  }),
});
export type CallIncoming = z.infer<typeof callIncomingSchema>;

/** `connectionId` is the device that answered; every other device of the callee stops ringing. */
export const callAcceptedSchema = z.object({ callId, connectionId: z.string() });
export type CallAccepted = z.infer<typeof callAcceptedSchema>;

export const callEndedSchema = z.object({ callId, reason: z.enum(CALL_END_REASONS) });
export type CallEnded = z.infer<typeof callEndedSchema>;

/** SDP is capped well above any real offer (a few KB) but far below anything abusive. */
export const callSdpSchema = z.object({ callId, sdp: z.string().min(1).max(100_000) });
export type CallSdp = z.infer<typeof callSdpSchema>;

export const callIceSchema = z.object({
  callId,
  candidate: z.object({
    candidate: z.string().max(2_000),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }),
});
export type CallIce = z.infer<typeof callIceSchema>;

export const callMediaStateSchema = z.object({ callId, audio: z.boolean(), video: z.boolean() });
export type CallMediaState = z.infer<typeof callMediaStateSchema>;

/** Sent by the server in `realtime.ready`: this socket's id, so a device can tell whether a
 *  `call.accepted` was its own answer or another device's ("answered elsewhere"). */
export const realtimeReadySchema = z.object({ connectionId: z.string() });
export type RealtimeReady = z.infer<typeof realtimeReadySchema>;

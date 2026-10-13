/**
 * The small part of the WebRTC API the call engine uses, written as plain interfaces. The phone's
 * implementation (react-native-webrtc) satisfies them, and so do the fakes in the tests, so the
 * engine never imports a native module and runs under plain Node.
 */
import type { IceServer } from '@videochat/shared';

export interface RtcTrack {
  readonly kind: string;
  enabled: boolean;
  stop(): void;
  /** react-native-webrtc: flips between the front and the back camera. */
  _switchCamera?(): void;
}

export interface RtcStream {
  readonly id?: string;
  getTracks(): RtcTrack[];
  getAudioTracks(): RtcTrack[];
  getVideoTracks(): RtcTrack[];
  addTrack(track: RtcTrack): void;
  removeTrack(track: RtcTrack): void;
  /** react-native-webrtc: what <RTCView streamURL> takes. */
  toURL?(): string;
}

export interface UserMediaConstraints {
  audio?: boolean | Record<string, unknown>;
  video?: boolean | Record<string, unknown>;
}

export interface RtcDescription {
  type: string | null;
  sdp: string;
}

export interface RtcSender {
  track: RtcTrack | null;
  replaceTrack(track: RtcTrack | null): Promise<void>;
}

export type RtcConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface RtcPeer {
  readonly signalingState: string;
  readonly connectionState: RtcConnectionState;
  readonly localDescription: RtcDescription | null;
  ontrack: ((event: { track: RtcTrack; streams?: RtcStream[] }) => void) | null;
  onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null;
  onnegotiationneeded: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: RtcTrack, ...streams: RtcStream[]): unknown;
  getSenders(): RtcSender[];
  /** No argument: the browser/native stack creates the right offer or answer itself. */
  setLocalDescription(description?: RtcDescription): Promise<void>;
  setRemoteDescription(description: RtcDescription): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  restartIce(): void;
  getStats(): Promise<{ forEach: (cb: (stat: Record<string, unknown>) => void) => void }>;
  close(): void;
}

export interface RtcConfiguration {
  iceServers: IceServer[];
}

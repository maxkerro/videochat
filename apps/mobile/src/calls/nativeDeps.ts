import { mediaDevices, MediaStream, RTCPeerConnection } from '@livekit/react-native-webrtc';
import { newCallId } from './ids';
import { fetchIceServers, postCallStats } from './callsApi';
import type { CallEngineDeps } from './CallEngine';
import type { MediaSource } from './media';
import { getConnectionId, sendRealtimeEvent, waitForRealtime } from '../realtime/connection';
import type { RtcPeer, RtcStream } from './rtc';

/** How long an answered call waits for the app's socket to come up (a cold start from the lock
 *  screen) before giving up. */
export const SIGNALLING_WAIT_MS = 20_000;

/**
 * CHAT-060: the call engine wired to the real thing -- react-native-webrtc for media, the app's
 * one realtime socket for signalling, the API for ICE servers and the end-of-call summary. The only
 * place that imports the native module, so everything else stays testable under plain Node.
 */
export function nativeCallDeps(): CallEngineDeps {
  return {
    // Only once the server has registered the socket (`realtime.ready`): before that it drops
    // every event, so "sent" would be a lie and a decline would be lost.
    send: (type, payload) => getConnectionId() !== null && sendRealtimeEvent(type, payload),
    getConnectionId,
    getIceServers: () => fetchIceServers().then((r) => r.iceServers),
    getUserMedia: (constraints) =>
      mediaDevices.getUserMedia(constraints as never) as unknown as Promise<RtcStream>,
    createPeerConnection: (config) => new RTCPeerConnection(config as never) as unknown as RtcPeer,
    createMediaStream: () => new MediaStream() as unknown as RtcStream,
    now: () => Date.now(),
    newCallId,
    waitForSignalling: () => waitForRealtime(SIGNALLING_WAIT_MS),
    reportStats: (callId, stats) => {
      void postCallStats(callId, stats).catch(() => undefined);
    },
  };
}

/** The real microphone and camera. */
export const nativeMedia: MediaSource = {
  getUserMedia: (constraints) =>
    mediaDevices.getUserMedia(constraints as never) as unknown as Promise<RtcStream>,
};

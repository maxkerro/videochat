import type { CallSnapshot } from './CallEngine';

type Mode = Pick<
  CallSnapshot,
  'phase' | 'media' | 'videoEnabled' | 'remoteVideoEnabled' | 'remoteStream'
>;

/** Whether picture is flowing in either direction right now. An audio call turns into a video
 *  call the moment someone turns a camera on, and back when both are off. */
export function isVideoCall(
  call: Pick<Mode, 'media' | 'videoEnabled' | 'remoteVideoEnabled'>,
): boolean {
  return call.videoEnabled || (call.media === 'video' && call.remoteVideoEnabled);
}

/** The audio side of a call is live from the moment media starts to connect until it ends. */
export function hasLiveAudio(call: Pick<Mode, 'phase'> | null): boolean {
  return call !== null && ['connecting', 'active', 'reconnecting'].includes(call.phase);
}

/** CHAT-062: whether leaving the app should keep the call on screen in a small window. Only a
 *  call that is connected (or connecting) and showing video. */
export function wantsPictureInPicture(call: Mode | null): boolean {
  return hasLiveAudio(call) && call !== null && isVideoCall(call);
}

/** How long the app must be out of sight before the camera is switched off, so a notification
 *  shade or a picture-in-picture hand-over does not blink it. */
export const BACKGROUND_PAUSE_DELAY_MS = 400;

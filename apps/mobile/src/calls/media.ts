import type { CallMedia } from '@videochat/shared';
import type { RtcStream, UserMediaConstraints } from './rtc';

/** Why the microphone or camera could not be used. */
export type MediaAccessProblem = 'microphone-denied' | 'unavailable';

export class MediaAccessError extends Error {
  constructor(readonly problem: MediaAccessProblem) {
    super(
      problem === 'microphone-denied'
        ? 'Microphone access is off'
        : 'The microphone or camera could not be started',
    );
    this.name = 'MediaAccessError';
  }
}

/** The camera as a call uses it: front-facing, sized for a phone screen and a mobile connection. */
export const CAMERA_CONSTRAINTS = {
  facingMode: 'user',
  width: 960,
  height: 540,
  frameRate: 30,
} as const;

const DENIED_ERRORS = new Set(['SecurityError', 'NotAllowedError', 'PermissionDeniedError']);

function isDenied(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && DENIED_ERRORS.has(name);
}

export interface MediaSource {
  getUserMedia(constraints: UserMediaConstraints): Promise<RtcStream>;
}

/**
 * Asks for the microphone (and the camera on a video call). react-native-webrtc shows the system
 * permission prompts itself and silently leaves out a track whose permission was refused, so this
 * checks what actually came back:
 *  - no microphone: the call cannot work, so this throws `MediaAccessError('microphone-denied')`
 *    (or 'unavailable' when the device could not start it for another reason);
 *  - no camera on a video call: the call goes ahead with sound only, and `cameraMissing` says so
 *    the screen can explain how to turn the camera on.
 */
export async function acquireMedia(
  source: MediaSource,
  media: CallMedia,
  options: { noiseSuppression?: boolean } = {},
): Promise<{ stream: RtcStream; cameraMissing: boolean }> {
  // CHAT-075: the phone's WebRTC noise suppression is on by default; only say so to turn it off.
  const audio = options.noiseSuppression === false ? { noiseSuppression: false } : true;
  let stream: RtcStream;
  try {
    stream = await source.getUserMedia({
      audio,
      video: media === 'video' ? { ...CAMERA_CONSTRAINTS } : false,
    });
  } catch (error) {
    if (media === 'video') {
      // The camera may be the problem (in use by another app, or refused along with the
      // microphone): try sound only before giving up.
      try {
        stream = await source.getUserMedia({ audio, video: false });
      } catch (audioError) {
        throw new MediaAccessError(isDenied(audioError) ? 'microphone-denied' : 'unavailable');
      }
      return { stream, cameraMissing: true };
    }
    throw new MediaAccessError(isDenied(error) ? 'microphone-denied' : 'unavailable');
  }
  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new MediaAccessError('microphone-denied');
  }
  return { stream, cameraMissing: media === 'video' && stream.getVideoTracks().length === 0 };
}

/** What to tell the person, and whether the fix is in the system settings. */
export function describeMediaProblem(problem: MediaAccessProblem): {
  title: string;
  message: string;
  openSettings: boolean;
} {
  return problem === 'microphone-denied'
    ? {
        title: 'Allow microphone access',
        message:
          'Calls need the microphone. Turn on Microphone for this app in your phone’s settings, then try again.',
        openSettings: true,
      }
    : {
        title: 'Can’t start the call',
        message:
          'The microphone or camera could not be started. Close other apps that might be using them and try again.',
        openSettings: false,
      };
}

export const CAMERA_OFF_NOTICE = {
  title: 'Camera is off',
  message:
    'The call is audio only because the camera is not available. To use video, turn on Camera for this app in your phone’s settings.',
} as const;

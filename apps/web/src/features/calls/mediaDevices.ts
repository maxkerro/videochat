import type { CallMedia } from '@videochat/shared';

/** CHAT-042: the camera/microphone the person last picked, remembered per browser so the next
 *  call (and an incoming call's quick "Accept") uses the same devices. */
export interface DevicePreferences {
  audioInputId?: string;
  videoInputId?: string;
}

const PREFS_KEY = 'videochat.callDevices';

export function loadDevicePreferences(): DevicePreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as DevicePreferences) : {};
  } catch {
    return {};
  }
}

export function saveDevicePreferences(prefs: DevicePreferences): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode / storage blocked: the choice just isn't remembered.
  }
}

/** getUserMedia constraints for a call. A remembered device that's since been unplugged would
 *  fail an `exact` constraint, so it's only a preference (`ideal`). */
export function mediaConstraints(
  media: CallMedia,
  prefs: DevicePreferences,
): MediaStreamConstraints {
  return {
    audio: prefs.audioInputId
      ? { deviceId: { ideal: prefs.audioInputId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true },
    video:
      media === 'video'
        ? prefs.videoInputId
          ? {
              deviceId: { ideal: prefs.videoInputId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : { width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
  };
}

export function hasMediaSupport(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Acquires the local stream for a call, with the person's remembered devices. */
export async function acquireMedia(
  media: CallMedia,
  prefs: DevicePreferences = loadDevicePreferences(),
): Promise<MediaStream> {
  if (!hasMediaSupport()) throw new MediaUnsupportedError();
  return navigator.mediaDevices.getUserMedia(mediaConstraints(media, prefs));
}

export class MediaUnsupportedError extends Error {
  constructor() {
    super('Media devices are not available');
    this.name = 'MediaUnsupportedError';
  }
}

export async function listDevices(): Promise<{
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
}> {
  if (!navigator.mediaDevices?.enumerateDevices) return { audioInputs: [], videoInputs: [] };
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    audioInputs: devices.filter((d) => d.kind === 'audioinput'),
    videoInputs: devices.filter((d) => d.kind === 'videoinput'),
  };
}

/** CHAT-042 AC: "Camera/microphone permission errors explain how to fix them." Maps
 *  getUserMedia's DOMException names to something a person can act on. */
export function describeMediaError(err: unknown, media: CallMedia): { title: string; fix: string } {
  const what = media === 'video' ? 'camera and microphone' : 'microphone';
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: `Access to your ${what} is blocked`,
        fix: `Click the camera/lock icon in your browser's address bar, allow the ${what} for this site, then try again. On macOS, also check System Settings → Privacy & Security → Camera / Microphone.`,
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        title: `No ${what} found`,
        fix: `Connect a ${media === 'video' ? 'camera and microphone' : 'microphone'} (or choose another one below), then try again.`,
      };
    case 'NotReadableError':
    case 'AbortError':
      return {
        title: `Your ${what} is in use`,
        fix: 'Another app or browser tab is using it. Close that app (Zoom, Teams, another call…) and try again.',
      };
    case 'MediaUnsupportedError':
      return {
        title: 'Calls aren’t supported here',
        fix: 'This browser can’t access a camera or microphone. Use a recent Chrome, Firefox, Safari or Edge over https.',
      };
    default:
      return {
        title: `Couldn’t start your ${what}`,
        fix: 'Check that it’s connected and not used by another app, then try again.',
      };
  }
}

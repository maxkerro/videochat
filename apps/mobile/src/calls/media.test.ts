import { describe, expect, it } from 'vitest';
import { acquireMedia, describeMediaProblem, MediaAccessError } from './media';
import type { RtcStream, UserMediaConstraints } from './rtc';

const track = (kind: 'audio' | 'video') => ({
  kind,
  enabled: true,
  stopped: false,
  stop() {
    this.stopped = true;
  },
});
function stream(kinds: ('audio' | 'video')[]) {
  const tracks = kinds.map(track);
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    addTrack: () => undefined,
    removeTrack: () => undefined,
  };
}
const denied = Object.assign(new Error('Permission denied.'), { name: 'SecurityError' });

describe('acquireMedia', () => {
  it('asks for sound and the front camera on a video call', async () => {
    let asked: UserMediaConstraints | null = null;
    const s = stream(['audio', 'video']);
    const result = await acquireMedia(
      { getUserMedia: async (c) => ((asked = c), s as unknown as RtcStream) },
      'video',
    );
    expect(asked).toMatchObject({ audio: true, video: { facingMode: 'user' } });
    expect(result).toEqual({ stream: s, cameraMissing: false });
  });

  it('asks for sound only on an audio call', async () => {
    let asked: UserMediaConstraints | null = null;
    await acquireMedia(
      { getUserMedia: async (c) => ((asked = c), stream(['audio']) as unknown as RtcStream) },
      'audio',
    );
    expect(asked).toEqual({ audio: true, video: false });
  });

  it('CHAT-075: turns noise suppression off when asked (on is the phone default)', async () => {
    let asked: UserMediaConstraints | null = null;
    await acquireMedia(
      { getUserMedia: async (c) => ((asked = c), stream(['audio']) as unknown as RtcStream) },
      'audio',
      { noiseSuppression: false },
    );
    expect(asked).toEqual({ audio: { noiseSuppression: false }, video: false });
  });

  it('carries on with sound only when the camera permission was refused', async () => {
    const result = await acquireMedia(
      { getUserMedia: async () => stream(['audio']) as unknown as RtcStream },
      'video',
    );
    expect(result.cameraMissing).toBe(true);
  });

  it('falls back to sound only when starting the camera fails outright', async () => {
    let calls = 0;
    const result = await acquireMedia(
      {
        getUserMedia: async (c) => {
          calls += 1;
          if (c.video) throw Object.assign(new Error('in use'), { name: 'NotReadableError' });
          return stream(['audio']) as unknown as RtcStream;
        },
      },
      'video',
    );
    expect(calls).toBe(2);
    expect(result.cameraMissing).toBe(true);
  });

  it('refuses to call without a microphone, and releases what it got', async () => {
    const s = stream(['video']);
    await expect(
      acquireMedia({ getUserMedia: async () => s as unknown as RtcStream }, 'video'),
    ).rejects.toMatchObject({ problem: 'microphone-denied' });
    expect(s.tracks.every((t) => t.stopped)).toBe(true);
  });

  it('reports a permission refusal as such, and any other failure as unavailable', async () => {
    await expect(
      acquireMedia(
        {
          getUserMedia: async () => {
            throw denied;
          },
        },
        'audio',
      ),
    ).rejects.toMatchObject({ problem: 'microphone-denied' });
    await expect(
      acquireMedia(
        {
          getUserMedia: async () => {
            throw Object.assign(new Error('x'), { name: 'NotFoundError' });
          },
        },
        'audio',
      ),
    ).rejects.toBeInstanceOf(MediaAccessError);
    await expect(
      acquireMedia(
        {
          getUserMedia: async () => {
            throw denied;
          },
        },
        'video',
      ),
    ).rejects.toMatchObject({ problem: 'microphone-denied' });
  });
});

describe('describeMediaProblem', () => {
  it('sends a refused microphone to the settings and not a busy device', () => {
    expect(describeMediaProblem('microphone-denied').openSettings).toBe(true);
    expect(describeMediaProblem('unavailable').openSettings).toBe(false);
  });
});

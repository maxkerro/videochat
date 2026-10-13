import { describe, expect, it } from 'vitest';
import { hasLiveAudio, isVideoCall, wantsPictureInPicture } from './callMode';

const base = {
  phase: 'active' as const,
  media: 'audio' as const,
  videoEnabled: false,
  remoteVideoEnabled: false,
  remoteStream: null,
};

describe('isVideoCall', () => {
  it('is video as soon as I send picture', () => {
    expect(isVideoCall({ ...base, videoEnabled: true })).toBe(true);
  });

  it('is video when the other side shows picture in a call that started as video', () => {
    expect(isVideoCall({ ...base, media: 'video', remoteVideoEnabled: true })).toBe(true);
  });

  it('is audio when both cameras are off', () => {
    expect(isVideoCall({ ...base, media: 'video' })).toBe(false);
    expect(isVideoCall(base)).toBe(false);
  });
});

describe('hasLiveAudio', () => {
  it('covers connecting through reconnecting only', () => {
    expect(
      ['outgoing', 'incoming', 'connecting', 'active', 'reconnecting', 'ended'].map((phase) =>
        hasLiveAudio({ phase } as never),
      ),
    ).toEqual([false, false, true, true, true, false]);
    expect(hasLiveAudio(null)).toBe(false);
  });
});

describe('wantsPictureInPicture', () => {
  it('wants it for a connected video call', () => {
    expect(wantsPictureInPicture({ ...base, videoEnabled: true })).toBe(true);
  });

  it('does not for an audio call, a ringing call or no call', () => {
    expect(wantsPictureInPicture(base)).toBe(false);
    expect(wantsPictureInPicture({ ...base, phase: 'incoming', videoEnabled: true })).toBe(false);
    expect(wantsPictureInPicture(null)).toBe(false);
  });
});

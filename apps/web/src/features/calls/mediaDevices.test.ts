import {
  describeMediaError,
  loadDevicePreferences,
  mediaConstraints,
  saveDevicePreferences,
} from './mediaDevices';

const named = (name: string) => Object.assign(new Error(name), { name });

describe('describeMediaError (CHAT-042: permission errors explain how to fix them)', () => {
  it('explains how to unblock a denied permission', () => {
    const { title, fix } = describeMediaError(named('NotAllowedError'), 'video');
    expect(title).toMatch(/blocked/i);
    expect(fix).toMatch(/address bar/i);
  });

  it('says when no device exists', () => {
    expect(describeMediaError(named('NotFoundError'), 'audio').title).toMatch(/no microphone/i);
  });

  it('says when another app holds the device', () => {
    expect(describeMediaError(named('NotReadableError'), 'video').fix).toMatch(/another app/i);
  });

  it('falls back to a generic but actionable message', () => {
    expect(describeMediaError(new Error('weird'), 'audio').fix).toMatch(/try again/i);
  });
});

describe('device preferences', () => {
  it('round-trips through storage and feeds the constraints as preferences, not requirements', () => {
    saveDevicePreferences({ audioInputId: 'mic-2', videoInputId: 'cam-3' });
    const prefs = loadDevicePreferences();
    expect(prefs).toEqual({ audioInputId: 'mic-2', videoInputId: 'cam-3' });
    const c = mediaConstraints('video', prefs);
    expect(c.audio).toMatchObject({ deviceId: { ideal: 'mic-2' } });
    expect(c.video).toMatchObject({ deviceId: { ideal: 'cam-3' } });
  });

  it('asks for no camera on an audio call', () => {
    expect(mediaConstraints('audio', {}).video).toBe(false);
  });
});

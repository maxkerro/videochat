import { describe, expect, it } from 'vitest';
import {
  AudioSession,
  defaultRoute,
  parseDeviceStatus,
  routeChoices,
  type AudioDeviceStatus,
  type AudioDriver,
  type AudioRoute,
} from './audioRoute';

function fakeDriver() {
  const log: string[] = [];
  let listener: ((s: AudioDeviceStatus) => void) | null = null;
  const driver: AudioDriver = {
    start: (media) => log.push(`start:${media}`),
    stop: () => log.push('stop'),
    choose: (route) => log.push(`choose:${route}`),
    watch: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return {
    driver,
    log,
    devices: (available: AudioRoute[], selected: AudioRoute | null = null) =>
      listener?.({ available, selected }),
    watching: () => listener !== null,
  };
}

describe('parseDeviceStatus', () => {
  it('reads the native payload', () => {
    expect(
      parseDeviceStatus({
        availableAudioDeviceList: '["SPEAKER_PHONE","BLUETOOTH","EARPIECE"]',
        selectedAudioDevice: 'BLUETOOTH',
      }),
    ).toEqual({ available: ['earpiece', 'speaker', 'bluetooth'], selected: 'bluetooth' });
  });

  it('survives garbage', () => {
    expect(parseDeviceStatus(undefined)).toEqual({ available: [], selected: null });
    expect(parseDeviceStatus({ availableAudioDeviceList: 'nope', selectedAudioDevice: 7 })).toEqual(
      {
        available: [],
        selected: null,
      },
    );
    expect(
      parseDeviceStatus({ availableAudioDeviceList: '["NONE","WIRED_HEADSET"]' }).available,
    ).toEqual(['headset']);
  });
});

describe('defaultRoute', () => {
  it('uses the speaker for video and the earpiece for audio', () => {
    expect(defaultRoute('video', ['earpiece', 'speaker'])).toBe('speaker');
    expect(defaultRoute('audio', ['earpiece', 'speaker'])).toBe('earpiece');
  });

  it('prefers a connected headset or Bluetooth device', () => {
    expect(defaultRoute('audio', ['earpiece', 'speaker', 'headset'])).toBe('headset');
    expect(defaultRoute('video', ['speaker', 'bluetooth', 'headset'])).toBe('bluetooth');
  });

  it('uses the speaker on a device without an earpiece, or before anything is known', () => {
    expect(defaultRoute('audio', ['speaker'])).toBe('speaker');
    expect(defaultRoute('audio', [])).toBe('speaker');
  });
});

describe('routeChoices', () => {
  it('always offers the speaker, plus what is connected, in a stable order', () => {
    expect(routeChoices([])).toEqual(['speaker']);
    expect(routeChoices(['bluetooth', 'earpiece'])).toEqual(['earpiece', 'speaker', 'bluetooth']);
  });
});

describe('AudioSession', () => {
  it('starts the platform audio and reports the route it picked, without changing it', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('video');
    expect(f.log).toEqual(['start:video']);
    expect(s.getSnapshot().route).toBeNull();
    f.devices(['earpiece', 'speaker'], 'speaker');
    expect(f.log).toEqual(['start:video']);
    expect(s.getSnapshot().route).toBe('speaker');
  });

  it('moves the sound to a Bluetooth headset as soon as it connects', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker']);
    f.log.length = 0;

    f.devices(['earpiece', 'speaker', 'bluetooth']);

    expect(f.log).toEqual(['choose:bluetooth']);
    expect(s.getSnapshot()).toEqual({
      route: 'bluetooth',
      choices: ['earpiece', 'speaker', 'bluetooth'],
    });
  });

  it('goes back to the phone when the headset is gone', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker', 'headset']);
    f.log.length = 0;

    f.devices(['earpiece', 'speaker']);

    expect(f.log).toEqual(['choose:earpiece']);
  });

  it('keeps an explicit pick while it is possible', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker']);
    s.choose('speaker');
    f.log.length = 0;

    f.devices(['earpiece', 'speaker']);
    s.setMedia('video');
    s.setMedia('audio');

    expect(f.log).toEqual([]);
    expect(s.getSnapshot().route).toBe('speaker');
  });

  it('follows the default when video starts and nothing was picked', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker']);
    f.log.length = 0;

    s.setMedia('video');
    expect(f.log).toEqual(['choose:speaker']);
    s.setMedia('audio');
    expect(f.log).toEqual(['choose:speaker', 'choose:earpiece']);
  });

  it('does not take the sound off a headset when video starts', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker', 'bluetooth']);
    f.log.length = 0;

    s.setMedia('video');

    expect(f.log).toEqual([]);
  });

  it('stops everything when the call ends, and ignores later calls to it', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    s.end();
    expect(f.log.at(-1)).toBe('stop');
    expect(f.watching()).toBe(false);
    f.log.length = 0;
    s.choose('speaker');
    s.end();
    expect(f.log).toEqual([]);
    expect(s.getSnapshot().route).toBeNull();
  });

  it('can be begun again for the next call with a clean slate', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker'], 'earpiece');
    s.choose('speaker');
    s.end();
    s.begin('audio');
    expect(s.getSnapshot().route).toBeNull();
    f.devices(['earpiece', 'speaker'], 'earpiece');
    s.setMedia('video');
    s.setMedia('audio');
    expect(s.getSnapshot().route).toBe('earpiece');
  });
});

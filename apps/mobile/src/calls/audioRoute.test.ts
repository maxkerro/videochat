import { describe, expect, it } from 'vitest';
import {
  AudioSession,
  defaultRoute,
  routeOfPort,
  RouteTracker,
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

const port = (portType: string) => ({ portType, portName: '', uid: '1' });
const route = (portType: string) => ({ currentRoute: { inputs: [], outputs: [port(portType)] } });

describe('routeOfPort', () => {
  it('maps the native port types', () => {
    expect(routeOfPort('builtInReceiver')).toBe('earpiece');
    expect(routeOfPort('builtInSpeaker')).toBe('speaker');
    expect(routeOfPort('headphones')).toBe('headset');
    expect(routeOfPort('usbAudio')).toBe('headset');
    expect(routeOfPort('bluetoothHFP')).toBe('bluetooth');
    expect(routeOfPort('bluetoothA2DP')).toBe('bluetooth');
    expect(routeOfPort('carAudio')).toBe('bluetooth');
  });

  it('ignores what it does not know', () => {
    expect(routeOfPort('hdmi')).toBeNull();
    expect(routeOfPort('android_99')).toBeNull();
    expect(routeOfPort(undefined)).toBeNull();
  });
});

describe('RouteTracker', () => {
  it('keeps the earpiece on offer while the speaker is in use', () => {
    const t = new RouteTracker();
    expect(t.update(route('builtInReceiver'))).toEqual({
      available: ['earpiece'],
      selected: 'earpiece',
    });
    expect(t.update(route('builtInSpeaker'))).toEqual({
      available: ['earpiece', 'speaker'],
      selected: 'speaker',
    });
  });

  it('keeps a headset until the system falls back to the earpiece', () => {
    const t = new RouteTracker();
    t.update(route('bluetoothHFP'));
    expect(t.update(route('builtInSpeaker')).available).toEqual(['speaker', 'bluetooth']);
    expect(t.update(route('builtInReceiver')).available).toEqual(['earpiece', 'speaker']);
  });

  it('uses the list when the platform gives one, and survives garbage', () => {
    const t = new RouteTracker();
    expect(
      t.update({
        currentRoute: { outputs: [port('builtInReceiver')] },
        availableRoutes: [port('builtInReceiver'), port('builtInSpeaker'), port('headphones')],
      }).available,
    ).toEqual(['earpiece', 'speaker', 'headset']);
    t.reset();
    expect(t.update(undefined)).toEqual({ available: [], selected: null });
    expect(t.update({ currentRoute: { outputs: 'x' }, availableRoutes: 3 })).toEqual({
      available: [],
      selected: null,
    });
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
  it('starts the platform audio and leaves a route that is already the default alone', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('video');
    expect(f.log).toEqual(['start:video']);
    expect(s.getSnapshot().route).toBeNull();
    f.devices(['earpiece', 'speaker'], 'speaker');
    expect(f.log).toEqual(['start:video']);
    expect(s.getSnapshot().route).toBe('speaker');
  });

  it('moves a video call to the speaker once the system reports the earpiece', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('video');
    f.devices(['earpiece'], 'earpiece');
    expect(f.log).toEqual(['start:video', 'choose:speaker']);
    f.devices(['earpiece', 'speaker'], 'speaker');
    expect(f.log).toHaveLength(2);
  });

  it('keeps an audio call on the earpiece and leaves a connected headset alone', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece'], 'earpiece');
    expect(f.log).toEqual(['start:audio']);
    const g = fakeDriver();
    const t = new AudioSession(g.driver);
    t.begin('video');
    g.devices(['earpiece', 'bluetooth'], 'bluetooth');
    expect(g.log).toEqual(['start:video']);
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
      active: true,
      media: 'audio',
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

  it('shows where the sound really is when the system did not move it', () => {
    const f = fakeDriver();
    const s = new AudioSession(f.driver);
    s.begin('audio');
    f.devices(['earpiece', 'speaker', 'bluetooth'], 'bluetooth');
    s.choose('earpiece');
    expect(s.getSnapshot().route).toBe('earpiece');
    f.devices(['earpiece', 'speaker', 'bluetooth'], 'bluetooth');
    expect(s.getSnapshot().route).toBe('bluetooth');
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

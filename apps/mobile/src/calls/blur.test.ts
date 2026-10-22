import { SLOW_SECONDS } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import { BlurController, type BlurNative, type EffectTrack } from './blur';

function fakeNative(available = true) {
  let listener: ((ms: number) => void) | null = null;
  const native: BlurNative = {
    isAvailable: () => available,
    processorName: () => 'videochat-blur',
    addStatsListener: (l) => {
      listener = l;
      return { remove: () => (listener = null) };
    },
  };
  return { native, stats: (ms: number) => listener?.(ms) };
}

class FakeTrack implements EffectTrack {
  readyState = 'live';
  effects: string[][] = [];
  constructor(public kind = 'video') {}
  _setVideoEffects(names: string[]) {
    this.effects.push(names);
  }
  get current() {
    return this.effects.at(-1);
  }
}

describe('background blur (CHAT-084)', () => {
  it('blurs a new camera from the start when the Settings choice is on', () => {
    const { native } = fakeNative();
    const blur = new BlurController(native, () => true);
    const camera = new FakeTrack();
    blur.attach(camera);
    expect(camera.current).toEqual(['videochat-blur']);
    expect(blur.getState()).toMatchObject({ available: true, on: true });
    const mic = new FakeTrack('audio');
    blur.attach(mic);
    expect(mic.effects).toEqual([]);
  });

  it('switches during a call, and the next call goes back to the Settings choice', () => {
    const { native } = fakeNative();
    let pref = false;
    const blur = new BlurController(native, () => pref);
    const camera = new FakeTrack();
    blur.attach(camera);
    expect(camera.current).toEqual([]);
    blur.setOn(true);
    expect(camera.current).toEqual(['videochat-blur']);

    // A camera turned on again in the same call keeps the in-call choice.
    camera.readyState = 'ended';
    const again = new FakeTrack();
    blur.attach(again);
    expect(again.current).toEqual(['videochat-blur']);

    again.readyState = 'ended';
    blur.callEnded();
    expect(blur.getState().on).toBe(false);
    pref = true;
    const next = new FakeTrack();
    blur.attach(next);
    expect(next.current).toEqual(['videochat-blur']);
  });

  it('turns itself off, with a notice, when the phone can’t keep up', () => {
    const { native, stats } = fakeNative();
    const blur = new BlurController(native, () => true);
    const camera = new FakeTrack();
    blur.attach(camera);
    for (let i = 0; i < SLOW_SECONDS - 1; i++) stats(80);
    stats(10); // a good second resets the count
    for (let i = 0; i < SLOW_SECONDS - 1; i++) stats(80);
    expect(blur.getState().on).toBe(true);
    stats(80);
    expect(blur.getState()).toMatchObject({ on: false, turnedOffSlow: true });
    expect(camera.current).toEqual([]);

    // Switching it back on is the person's call; the notice goes away.
    blur.setOn(true);
    expect(blur.getState()).toMatchObject({ on: true, turnedOffSlow: false });
  });

  it('does nothing where the app build has no blur', () => {
    const { native } = fakeNative(false);
    const blur = new BlurController(native, () => true);
    const camera = new FakeTrack();
    blur.attach(camera);
    blur.setOn(true);
    expect(camera.effects).toEqual([]);
    expect(blur.getState()).toMatchObject({ available: false, on: false });
  });

  it('tells subscribers about changes', () => {
    const { native } = fakeNative();
    const blur = new BlurController(native, () => false);
    let calls = 0;
    const off = blur.subscribe(() => calls++);
    blur.setOn(true);
    blur.setOn(true);
    off();
    blur.setOn(false);
    expect(calls).toBe(1);
  });
});
